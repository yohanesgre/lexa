import type { ReactNode } from "react";
import type { AssistantWriteDiff } from "../../../shared/assistant";
import { diffText } from "../../../shared/diff";
import { DiffView } from "../assistant/DiffView";
import { DiffTable, FieldList, MovePills, TextBlock, ConfirmLine } from "./assistant-diff-parts";
import { bodySummary } from "./assistant-diff-utils";
import type { ApprovalChip } from "./AssistantApprovals";

// Diff body dispatch (assistant-write-approvals.html): destructive/confirm
// kinds render copy lines; structured kinds render fields/tables/pills. Bodies
// that MUTATE an existing text (a description, a wiki page) render a unified
// diff via the shared engine (`shared/diff.ts` → `DiffView`) instead of two
// full before/after blocks.

type DiffOf<K extends AssistantWriteDiff["type"]> = Extract<AssistantWriteDiff, { type: K }>;

const CONFIRM_COPY: Partial<Record<AssistantWriteDiff["type"], (d: AssistantWriteDiff) => ReactNode>> = {
  task_archive: (d) => {
    const t = d as DiffOf<"task_archive">;
    return <>Archives <span className="font-mono text-lx-text-primary">{t.taskRef}</span> — &ldquo;{t.taskTitle}&rdquo;. The task leaves the board but stays searchable.</>;
  },
  task_restore: (d) => {
    const t = d as DiffOf<"task_restore">;
    return <>Restores <span className="font-mono text-lx-text-primary">{t.taskRef}</span> — &ldquo;{t.taskTitle}&rdquo;.</>;
  },
  task_delete: (d) => {
    const t = d as DiffOf<"task_delete">;
    return <>Deletes <span className="font-mono text-lx-text-primary">{t.taskRef}</span> — &ldquo;{t.taskTitle}&rdquo;. This cannot be undone.</>;
  },
  wiki_delete: (d) => {
    const t = d as DiffOf<"wiki_delete">;
    return <>Deletes page <span className="font-mono text-lx-text-primary">{t.slug}</span> — &ldquo;{t.title}&rdquo;.</>;
  },
  milestone_archive: (d) => {
    const t = d as DiffOf<"milestone_archive">;
    return <>Archives milestone <span className="text-lx-text-primary">{t.name}</span>. Its tasks stay untouched.</>;
  },
  milestone_delete: (d) => {
    const t = d as DiffOf<"milestone_delete">;
    return <>Deletes milestone <span className="text-lx-text-primary">{t.name}</span>.</>;
  },
  sprint_archive: (d) => {
    const t = d as DiffOf<"sprint_archive">;
    return <>Archives sprint <span className="text-lx-text-primary">{t.name}</span>. Its live tasks archive with it.</>;
  },
  sprint_delete: (d) => {
    const t = d as DiffOf<"sprint_delete">;
    return <>Deletes sprint <span className="text-lx-text-primary">{t.name}</span>.</>;
  },
};

const STRUCTURED_COPY: Partial<Record<AssistantWriteDiff["type"], (d: AssistantWriteDiff) => ReactNode>> = {
  task_create: (d) => {
    const t = d as DiffOf<"task_create">;
    return (
      <FieldList
        rows={[
          { label: "Title", value: t.title, primary: true },
          // The description can be a whole page: name it and count it rather
          // than inlining the body into the approval chip.
          ...Object.entries(t.fields).map(([k, v]) => ({
            label: k,
            value: k === "description" && v !== null ? bodySummary(v) : v,
          })),
        ]}
      />
    );
  },
  task_update: (d) => {
    const t = d as DiffOf<"task_update">;
    const body = t.changes.filter((c) => c.field === "description");
    const rest = t.changes.filter((c) => c.field !== "description");
    return (
      <>
        {rest.length > 0 ? <DiffTable changes={rest} /> : null}
        {body.map((c) => (
          <section key={c.field} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="approval-blocklabel">Description</div>
            <DiffView diff={diffText(c.before ?? "", c.after ?? "")} />
          </section>
        ))}
      </>
    );
  },
  task_move: (d) => {
    const t = d as DiffOf<"task_move">;
    return <MovePills from={t.fromColumn} to={t.toColumn} />;
  },
  comment: (d) => <TextBlock label="Comment body" text={(d as DiffOf<"comment">).bodyText} tone="before" />,
  wiki_create: (d) => {
    const t = d as DiffOf<"wiki_create">;
    return (
      <FieldList
        rows={[
          { label: "Title", value: t.title, primary: true },
          { label: "Parent page", value: t.slug },
        ]}
      />
    );
  },
  wiki_edit: (d) => {
    const t = d as DiffOf<"wiki_edit">;
    return <DiffView diff={diffText(t.beforeText, t.afterText)} />;
  },
  milestone_create: (d) => <FieldList rows={[{ label: "Name", value: (d as DiffOf<"milestone_create">).name, primary: true }]} />,
  milestone_update: (d) => <DiffTable changes={(d as DiffOf<"milestone_update">).changes ?? []} />,
  sprint_create: (d) => <FieldList rows={[{ label: "Name", value: (d as DiffOf<"sprint_create">).name, primary: true }]} />,
  sprint_update: (d) => <DiffTable changes={(d as DiffOf<"sprint_update">).changes ?? []} />,
  swimlane_move: (d) => {
    const t = d as DiffOf<"swimlane_move">;
    return <MovePills from={t.fromMilestone ?? "Backlog"} to={t.toMilestone ?? "Backlog"} />;
  },
};

function DiffBodyConfirm({ chip }: { chip: ApprovalChip }) {
  const render = CONFIRM_COPY[chip.diff.type];
  return <ConfirmLine>{render ? render(chip.diff) : null}</ConfirmLine>;
}

function DiffBodyStructured({ chip }: { chip: ApprovalChip }) {
  const render = STRUCTURED_COPY[chip.diff.type];
  return <>{render ? render(chip.diff) : null}</>;
}

export function DiffBody({ chip }: { chip: ApprovalChip }) {
  if (CONFIRM_COPY[chip.diff.type]) return <DiffBodyConfirm chip={chip} />;
  return <DiffBodyStructured chip={chip} />;
}
