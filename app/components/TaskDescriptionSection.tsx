import type { TipTapDoc } from "../../shared/types";
import { renderDoc } from "./tiptap-render";
import { DescriptionEditor } from "./DescriptionEditor";
import { LinksSection } from "./forge/LinksSection";
import { SourcesSection } from "./forge/SourcesSection";

interface TaskDescriptionSectionProps {
  isCreate: boolean;
  slug: string | undefined;
  task: { id: string; description: TipTapDoc } | null;
  emptyDoc: TipTapDoc;
  taskTitles: Map<string, string> | undefined;
  taskKeys: Map<string, string> | undefined;
  editingDescription: boolean;
  setEditingDescription: (v: boolean) => void;
  setCreateDescription: (v: TipTapDoc) => void;
  onUpdate: (id: string, data: { description: TipTapDoc }) => void;
}

export function TaskDescriptionSection({ isCreate, slug, task, emptyDoc, taskTitles, taskKeys, editingDescription, setEditingDescription, setCreateDescription, onUpdate }: TaskDescriptionSectionProps) {
  return (
<>
{isCreate ? (
  <>
    <DescriptionEditor
      initialContent={emptyDoc}
      onChange={setCreateDescription}
      placeholder="Add a description..."
      forge={slug ? { slug, documentType: "task", documentId: task?.id ?? "" } : undefined}
    />
    <div className="mt-4 border border-dashed border-lx-border-default rounded-md p-3 text-xs text-lx-text-muted font-body">
      No GitHub section in create mode — linking is available after the task exists.
    </div>
  </>
) : (
  <>
    {editingDescription ? (
      <DescriptionEditor
        initialContent={task!.description}
        editable={true}
        forge={slug ? { slug, documentType: "task", documentId: task!.id } : undefined}
        attachments={slug ? { slug, documentId: task!.id } : undefined}
        onBlur={(doc) => {
          onUpdate?.(task!.id, { description: doc });
          setEditingDescription(false);
        }}
        onDone={(doc) => {
          onUpdate?.(task!.id, { description: doc });
          setEditingDescription(false);
        }}
        onCancel={() => {
          setEditingDescription(false);
        }}
      />
    ) : (
      <div className="td-prose" onDoubleClick={() => setEditingDescription(true)}>
        {renderDoc(task!.description, "task")}
      </div>
    )}

    {!isCreate && slug && (
      <LinksSection
        slug={slug}
        taskId={task!.id}
        taskTitleById={taskTitles}
        taskKeyById={taskKeys}
        className="mt-4 pt-4 border-t border-lx-border-subtle"
      />
    )}
    {!isCreate && slug && (
      <SourcesSection
        slug={slug}
        documentType="task"
        documentId={task!.id}
        className="mt-4 pt-4 border-t border-lx-border-subtle"
      />
    )}
  </>
)}
</>
  );
}
