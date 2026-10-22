import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { WikiPage } from "../../../shared/types";
import { useUpdateWikiPage, useRestoreWikiRevision } from "../../lib/queries";
import * as api from "../../lib/api";
import { Effect } from "effect";
import { ApiError, createWikiAutosaveEffect, type DebouncedEffect } from "../../lib/effect-api";

interface EditState {
  isEditing: boolean;
  title: string;
  lastSavedPage: WikiPage;
  lastSavedAt: Date | null;
  isDirty: boolean;
  isSaving: boolean;
}

function initEditState(page: WikiPage): EditState {
  return {
    isEditing: false,
    title: page.title,
    lastSavedPage: page,
    lastSavedAt: null,
    isDirty: false,
    isSaving: false,
  };
}

type EditAction =
  | { type: "reset"; page: WikiPage }
  | { type: "start"; page: WikiPage }
  | { type: "title"; title: string }
  | { type: "dirty" }
  | { type: "saving" }
  | { type: "saved"; page: WikiPage; at: Date; stale?: boolean }
  | { type: "cancel"; page: WikiPage }
  | { type: "stopEditing" }
  | { type: "done" };

function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "reset":
      return initEditState(action.page);
    case "start":
      return { ...initEditState(action.page), isEditing: true };
    case "title":
      return { ...state, title: action.title, isDirty: true };
    case "dirty":
      return state.isDirty ? state : { ...state, isDirty: true };
    case "saving":
      return { ...state, isSaving: true };
    case "saved":
      if (action.stale) return { ...state, lastSavedPage: action.page, lastSavedAt: action.at };
      return { ...state, title: action.page.title, lastSavedPage: action.page, lastSavedAt: action.at, isDirty: false };
    case "cancel":
      return { ...state, title: action.page.title, lastSavedPage: action.page, isDirty: false, isSaving: false };
    case "stopEditing":
      return { ...state, isEditing: false, isDirty: false, isSaving: false };
    case "done":
      return { ...state, isSaving: false };
  }
}

export function useWikiEditor({ slug, page }: { slug: string; page: WikiPage }) {
  const navigate = useNavigate();
  const updateWikiPage = useUpdateWikiPage(slug);
  const restoreWikiPage = useRestoreWikiRevision(slug);
  const [edit, dispatch] = useReducer(editReducer, page, initEditState);
  const { isEditing, title, lastSavedPage, lastSavedAt, isDirty, isSaving } = edit;
  const [source, setSource] = useState(page.content ?? "");
  const sourceRef = useRef(source);
  const [isManualSaving, setIsManualSaving] = useState(false);
  const [historyPreviewId, setHistoryPreviewId] = useState<string | null>(null);
  const [autosaveEnabled, setAutosaveEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("lexa-wiki-autosave");
    return stored === null ? false : stored === "true";
  });
  const [autosaveDelay, setAutosaveDelay] = useState(() => {
    if (typeof window === "undefined") return 800;
    const stored = window.localStorage.getItem("lexa-wiki-autosave-delay");
    return stored === null ? 800 : Number(stored) || 800;
  });

  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave", String(autosaveEnabled));
  }, [autosaveEnabled]);
  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave-delay", String(autosaveDelay));
  }, [autosaveDelay]);

  const pageIdentity = `${slug}:${page.id}:${page.slug}`;
  const pageIdentityRef = useRef(pageIdentity);
  const editSessionRef = useRef(0);
  const latestSaveRequestRef = useRef(0);
  const titleRef = useRef(title);
  const editVersionRef = useRef(0);
  const markDirtyRef = useRef<() => void>(() => {});
  const reviewActiveRef = useRef(false);
  const historyPreviewRef = useRef<string | null>(null);
  const previewSnapshotRef = useRef<string | null>(null);
  const autosaveHandleRef = useRef<DebouncedEffect<string> | null>(null);
  const autosaveMutationRef = useRef(updateWikiPage.mutateAsync);
  const navigateRef = useRef(navigate);
  const pageSlugRef = useRef(page.slug);
  const revisionRequestRef = useRef(0);
  const manualSaveInProgressRef = useRef(false);
  const autosaveRequestsRef = useRef(new Set<Promise<WikiPage>>());

  useLayoutEffect(() => {
    if (pageIdentityRef.current === pageIdentity) return;
    pageIdentityRef.current = pageIdentity;
    editSessionRef.current += 1;
    latestSaveRequestRef.current += 1;
    revisionRequestRef.current += 1;
    autosaveHandleRef.current?.cancel();
    previewSnapshotRef.current = null;
    reviewActiveRef.current = false;
    historyPreviewRef.current = null;
    setHistoryPreviewId(null);
    const next = page.content ?? "";
    sourceRef.current = next;
    setSource(next);
    titleRef.current = page.title;
    pageSlugRef.current = page.slug;
    dispatch({ type: "reset", page });
  }, [page, pageIdentity]);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    historyPreviewRef.current = historyPreviewId;
  }, [historyPreviewId]);


  const save = async (saveType: "autosave" | "manual" = "manual") => {
    const isManual = saveType === "manual";
    if (isManual && manualSaveInProgressRef.current) return;
    if (isManual) {
      manualSaveInProgressRef.current = true;
      setIsManualSaving(true);
    }
    autosaveHandleRef.current?.cancel();
    const identityAtStart = pageIdentityRef.current;
    const sessionAtStart = editSessionRef.current;
    const requestId = ++latestSaveRequestRef.current;
    const versionAtStart = editVersionRef.current;
    const titleAtStart = titleRef.current;
    const content = sourceRef.current;
    const pageSlug = page.slug;
    dispatch({ type: "saving" });
    try {
      if (isManual) {
        await Promise.allSettled([...autosaveRequestsRef.current]);
        if (pageIdentityRef.current !== identityAtStart || editSessionRef.current !== sessionAtStart) return true;
      }
      const savedPage = await updateWikiPage.mutateAsync({
        projectSlug: slug,
        pageSlug,
        title: titleAtStart,
        content,
        saveType,
      });
      const current = pageIdentityRef.current === identityAtStart && editSessionRef.current === sessionAtStart;
      const latestRequest = latestSaveRequestRef.current === requestId;
      const stale = !current || editVersionRef.current !== versionAtStart || !latestRequest;
      if (current && latestRequest) dispatch({ type: "saved", page: savedPage, at: new Date(), stale });
      if (!stale && savedPage.slug !== pageSlug) {
        navigateRef.current({
          to: "/$slug/wiki/$pageSlug",
          params: { slug, pageSlug: savedPage.slug },
          replace: true,
        });
      }
      return stale;
    } finally {
      if (isManual) {
        manualSaveInProgressRef.current = false;
        setIsManualSaving(false);
      }
      if (pageIdentityRef.current === identityAtStart && editSessionRef.current === sessionAtStart && latestSaveRequestRef.current === requestId) {
        dispatch({ type: "done" });
      }
    }
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
    autosaveMutationRef.current = updateWikiPage.mutateAsync;
    navigateRef.current = navigate;
    pageSlugRef.current = page.slug;
  });

  useEffect(() => {
    autosaveHandleRef.current?.destroy();
    const handle = createWikiAutosaveEffect(
      (content) => {
        if (manualSaveInProgressRef.current || reviewActiveRef.current || historyPreviewRef.current !== null) return Effect.succeed(undefined);
        const identityAtStart = pageIdentityRef.current;
        const sessionAtStart = editSessionRef.current;
        const requestId = ++latestSaveRequestRef.current;
        const versionAtStart = editVersionRef.current;
        const titleAtStart = titleRef.current;
        const pageSlug = pageSlugRef.current;
        return Effect.tryPromise({
          try: () => {
            const request = autosaveMutationRef.current({
              projectSlug: slug,
              pageSlug,
              title: titleAtStart,
              content,
              saveType: "autosave",
            });
            autosaveRequestsRef.current.add(request);
            void request.then(
              () => autosaveRequestsRef.current.delete(request),
              () => autosaveRequestsRef.current.delete(request)
            );
            return request.then((saved) => ({ saved, identityAtStart, sessionAtStart, requestId, versionAtStart, pageSlug, slug }));
          },
          catch: (error) => new ApiError({ code: "AUTOSAVE_FAILED", message: error instanceof Error ? error.message : String(error) }),
        }).pipe(
          Effect.flatMap((result) =>
            Effect.sync(() => {
              const { saved, identityAtStart, sessionAtStart, requestId, versionAtStart, pageSlug, slug } = result;
              const current = pageIdentityRef.current === identityAtStart && editSessionRef.current === sessionAtStart;
              const latestRequest = latestSaveRequestRef.current === requestId;
              const stale = !current || editVersionRef.current !== versionAtStart || !latestRequest;
              if (current && latestRequest) dispatch({ type: "saved", page: saved, at: new Date(), stale });
              if (!stale && saved.slug !== pageSlug) {
                navigateRef.current({
                  to: "/$slug/wiki/$pageSlug",
                  params: { slug, pageSlug: saved.slug },
                  replace: true,
                });
              }
              if (current && latestRequest) dispatch({ type: "done" });
            })
          ),
          Effect.catchAll(() =>
            Effect.sync(() => {
              if (pageIdentityRef.current === identityAtStart && editSessionRef.current === sessionAtStart && latestSaveRequestRef.current === requestId) {
                dispatch({ type: "done" });
              }
            })
          )
        );
      },
      autosaveDelay
    );
    autosaveHandleRef.current = handle;
    return () => handle.destroy();
  }, [autosaveDelay, page.slug, slug]);

  const markDirty = useCallback(() => {
    editVersionRef.current += 1;
    dispatch({ type: "dirty" });
    if (manualSaveInProgressRef.current || reviewActiveRef.current || historyPreviewRef.current !== null || !autosaveEnabled) return;
    autosaveHandleRef.current?.trigger(sourceRef.current);
  }, [autosaveEnabled]);

  useEffect(() => {
    markDirtyRef.current = markDirty;
  }, [markDirty]);
  const handleReviewStateChange = useCallback((active: boolean, accepted: boolean) => {
    const wasActive = reviewActiveRef.current;
    reviewActiveRef.current = active;
    if (active) autosaveHandleRef.current?.cancel();
    else if (wasActive && historyPreviewRef.current === null && isEditing && autosaveEnabled && (accepted || isDirty)) {
      autosaveHandleRef.current?.trigger(sourceRef.current);
    }
  }, [isEditing, autosaveEnabled, isDirty]);


  const handleMarkdownChange = useCallback((next: string) => {
    if (manualSaveInProgressRef.current || historyPreviewRef.current !== null) return;
    sourceRef.current = next;
    setSource(next);
    markDirtyRef.current();
  }, []);

  const handleSelectRevision = async (revisionId: string) => {
    if (reviewActiveRef.current || historyPreviewRef.current === revisionId) return;
    autosaveHandleRef.current?.cancel();
    const request = ++revisionRequestRef.current;
    const identityAtStart = pageIdentityRef.current;
    const sessionAtStart = editSessionRef.current;
    const versionAtStart = editVersionRef.current;
    const requestedPageSlug = page.slug;
    try {
      const { revision } = await api.getWikiRevision(slug, requestedPageSlug, revisionId);
      if (
        revisionRequestRef.current !== request ||
        pageIdentityRef.current !== identityAtStart ||
        editSessionRef.current !== sessionAtStart ||
        editVersionRef.current !== versionAtStart ||
        reviewActiveRef.current ||
        revision.id !== revisionId ||
        revision.pageId !== page.id ||
        typeof revision.content !== "string"
      ) return;
      if (previewSnapshotRef.current === null) previewSnapshotRef.current = sourceRef.current;
      historyPreviewRef.current = revisionId;
      setHistoryPreviewId(revisionId);
      sourceRef.current = revision.content;
      setSource(revision.content);
    } catch {
      if (revisionRequestRef.current !== request || pageIdentityRef.current !== identityAtStart || editSessionRef.current !== sessionAtStart) return;
      historyPreviewRef.current = null;
      const snapshot = previewSnapshotRef.current;
      if (snapshot !== null) {
        previewSnapshotRef.current = null;
        sourceRef.current = snapshot;
        setSource(snapshot);
      }
      setHistoryPreviewId(null);
    }
  };

  const handleClosePreview = () => {
    revisionRequestRef.current += 1;
    historyPreviewRef.current = null;
    const snapshot = previewSnapshotRef.current;
    previewSnapshotRef.current = null;
    setHistoryPreviewId(null);
    if (snapshot !== null) {
      sourceRef.current = snapshot;
      setSource(snapshot);
    }
  };

  const handleRestore = async (revisionId: string) => {
    autosaveHandleRef.current?.cancel();
    latestSaveRequestRef.current += 1;
    editVersionRef.current += 1;
    const identityAtStart = pageIdentityRef.current;
    const sessionAtStart = editSessionRef.current;
    const requestedPageSlug = page.slug;
    const versionAtStart = editVersionRef.current;
    try {
      const restored = await restoreWikiPage.mutateAsync({ projectSlug: slug, pageSlug: requestedPageSlug, revisionId });
      if (
        pageIdentityRef.current !== identityAtStart ||
        editSessionRef.current !== sessionAtStart ||
        editVersionRef.current !== versionAtStart
      ) return;
      const restoredSource = restored.content ?? "";
      sourceRef.current = restoredSource;
      setSource(restoredSource);
      titleRef.current = restored.title;
      dispatch({ type: "title", title: restored.title });
      dispatch({ type: "saved", page: restored, at: new Date() });
      autosaveHandleRef.current?.cancel();
      previewSnapshotRef.current = null;
      historyPreviewRef.current = null;
      revisionRequestRef.current += 1;
      setHistoryPreviewId(null);
      if (restored.slug !== requestedPageSlug) {
        navigateRef.current({
          to: "/$slug/wiki/$pageSlug",
          params: { slug, pageSlug: restored.slug },
          replace: true,
        });
      }
    } catch {
      // Keep the current draft when a restore fails.
    }
  };

  const handleStartEditing = () => {
    editSessionRef.current += 1;
    dispatch({ type: "start", page });
    const next = page.content ?? "";
    sourceRef.current = next;
    setSource(next);
    titleRef.current = page.title;
  };

  const handleCancel = () => {
    editSessionRef.current += 1;
    latestSaveRequestRef.current += 1;
    revisionRequestRef.current += 1;
    autosaveHandleRef.current?.cancel();
    reviewActiveRef.current = false;
    previewSnapshotRef.current = null;
    historyPreviewRef.current = null;
    setHistoryPreviewId(null);
    dispatch({ type: "cancel", page: lastSavedPage });
    sourceRef.current = lastSavedPage.content ?? "";
    setSource(sourceRef.current);
    titleRef.current = lastSavedPage.title;
    dispatch({ type: "stopEditing" });
  };

  const handleSave = async () => {
    if (isSaving || reviewActiveRef.current || historyPreviewRef.current !== null) return;
    if (isDirty) {
      let stale = false;
      try {
        stale = (await saveRef.current("manual")) ?? false;
      } catch {
        return;
      }
      if (stale) return;
    }
    dispatch({ type: "stopEditing" });
  };

  useEffect(() => () => {
    editSessionRef.current += 1;
    latestSaveRequestRef.current += 1;
    revisionRequestRef.current += 1;
    autosaveHandleRef.current?.destroy();
  }, []);

  const sourceForPage = pageIdentityRef.current === pageIdentity ? source : page.content ?? "";
  return {
    isEditing,
    title,
    lastSavedPage,
    lastSavedAt,
    isDirty,
    isManualSaving,
    isSaving,
    restoring: restoreWikiPage.isPending,
    source: sourceForPage,
    historyPreviewId,
    autosaveEnabled,
    autosaveDelay,
    setAutosaveEnabled,
    setAutosaveDelay,
    handleStartEditing,
    handleCancel,
    handleSave,
    handleMarkdownChange,
    handleSelectRevision,
    handleClosePreview,
    handleRestore,
    handleReviewStateChange,
    handleTitleChange: (next: string) => {
      dispatch({ type: "title", title: next });
      markDirty();
    },
  };
}
