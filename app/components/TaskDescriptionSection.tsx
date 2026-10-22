import { useLayoutEffect, useRef } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { DescriptionEditor } from "./DescriptionEditor";
import { LinksSection } from "./document/LinksSection";
import { SourcesSection } from "./document/SourcesSection";
const taskDescriptionSaveQueues = new Map<string, Promise<void>>();

interface TaskDescriptionSectionProps {
  isCreate: boolean;
  slug: string | undefined;
  task: { id: string; description: string } | null;
  emptyContent: string;
  taskTitles: Map<string, string> | undefined;
  taskKeys: Map<string, string> | undefined;
  editingDescription: boolean;
  setEditingDescription: (v: boolean) => void;
  setCreateDescription: (source: string) => void;
  onSaveDescription: (id: string, data: { description: string }) => Promise<void>;
}

export function TaskDescriptionSection({ isCreate, slug, task, emptyContent, taskTitles, taskKeys, editingDescription, setEditingDescription, setCreateDescription, onSaveDescription }: TaskDescriptionSectionProps) {
  const sessionRef = useRef(0);
  const sourceVersionRef = useRef(0);
  const saveGenerationRef = useRef(0);
  const cancellationEpochsRef = useRef(new Map<string, number>());
  const saveRef = useRef<{ session: number; source: string; promise: Promise<void> } | null>(null);
  const taskIdentity = `${slug ?? ""}:${task?.id ?? ""}`;
  const currentTaskIdentityRef = useRef(taskIdentity);

  useLayoutEffect(() => {
    if (currentTaskIdentityRef.current === taskIdentity) return;
    currentTaskIdentityRef.current = taskIdentity;
    sessionRef.current += 1;
    saveGenerationRef.current += 1;
    sourceVersionRef.current = 0;
    setEditingDescription(false);
  }, [taskIdentity, setEditingDescription]);

  useLayoutEffect(() => () => {
    sessionRef.current += 1;
    saveGenerationRef.current += 1;
    saveRef.current = null;
  }, []);

  const beginEditing = () => {
    sessionRef.current += 1;
    sourceVersionRef.current = 0;
    setEditingDescription(true);
  };
  const cancelEditing = () => {
    cancellationEpochsRef.current.set(taskIdentity, (cancellationEpochsRef.current.get(taskIdentity) ?? 0) + 1);
    sessionRef.current += 1;
    saveGenerationRef.current += 1;
    saveRef.current = null;
    setEditingDescription(false);
  };
  const saveDescription = (source: string) => {
    const session = sessionRef.current;
    const identity = taskIdentity;
    const taskId = task?.id;
    const cancellationEpoch = cancellationEpochsRef.current.get(identity) ?? 0;
    if (!taskId) return Promise.resolve();
    const current = saveRef.current;
    if (current?.session === session && current.source === source) return current.promise;
    const version = sourceVersionRef.current;
    const generation = ++saveGenerationRef.current;
    const previous = taskDescriptionSaveQueues.get(identity) ?? Promise.resolve();
    const promise = previous.then(async () => {
      if (cancellationEpoch !== (cancellationEpochsRef.current.get(identity) ?? 0)) return;
      try {
        await onSaveDescription(taskId, { description: source });
        if (
          session === sessionRef.current &&
          generation === saveGenerationRef.current &&
          version === sourceVersionRef.current &&
          currentTaskIdentityRef.current === identity
        ) {
          setEditingDescription(false);
        }
      } catch {
        // Keep the editor and draft open after the mutation reports failure.
      }
    }).finally(() => {
      if (taskDescriptionSaveQueues.get(identity) === promise) taskDescriptionSaveQueues.delete(identity);
      if (saveRef.current?.promise === promise) saveRef.current = null;
    });
    taskDescriptionSaveQueues.set(identity, promise);
    saveRef.current = { session, source, promise };
    return promise;
  };
  const handleSourceChange = () => {
    sourceVersionRef.current += 1;
  };
  return (
    <>
      {isCreate ? (
        <>
          <DescriptionEditor key={`${slug ?? ""}:create`}
            initialContent={emptyContent}
            onChange={setCreateDescription}
            runtime={slug ? { slug, documentType: "task", documentId: task?.id ?? "" } : undefined}
          />
          <div className="mt-4 border border-dashed border-lx-border-default rounded-md p-3 text-xs text-lx-text-muted font-body">
            No GitHub section in create mode. Linking is available after the task exists.
          </div>
        </>
      ) : (
        <>
          {editingDescription ? (
            <DescriptionEditor
              key={`${slug ?? ""}:${task!.id}`}
              initialContent={task!.description}
              editable
              runtime={slug ? { slug, documentType: "task", documentId: task!.id } : undefined}
              attachments={slug ? { slug, documentId: task!.id } : undefined}
              onChange={handleSourceChange}
              onBlur={saveDescription}
              onDone={saveDescription}
              onCancel={cancelEditing}
            />
          ) : (
            <div className="td-prose" onDoubleClick={beginEditing}>
              {task!.description.length > 0
                ? <MarkdownContent md={task!.description} surface="task" />
                : <p className="td-p italic text-lx-text-muted">Add a description...</p>}
            </div>
          )}

          {slug && (
            <SourcesSection
              slug={slug}
              documentType="task"
              documentId={task!.id}
              className="mt-4 pt-4 border-t border-lx-border-subtle"
            />
          )}
          {slug && (
            <LinksSection
              slug={slug}
              taskId={task!.id}
              taskTitleById={taskTitles}
              taskKeyById={taskKeys}
              className="mt-4 pt-4 border-t border-lx-border-subtle"
            />
          )}
        </>
      )}
    </>
  );
}
