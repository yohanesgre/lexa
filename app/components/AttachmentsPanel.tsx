import { useRef, useState } from "react";
import type { Attachment } from "../../shared/types";
import { useTaskAttachments, useUploadAttachment, useDeleteAttachment } from "../lib/queries";
import { Menu } from "./ui/Menu";
import { cn } from "./ui/cn";

// Transcribed from wireframes/src/task-detail-attachments.html: header +
// count + Upload, inline-preview vs forced-download rows, uploading row
// (spinner + progress + cancel), drag-drop active state, empty state.
interface AttachmentsPanelProps {
  slug: string;
  taskId: string;
}

function PaperclipIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function ImageThumbIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function FileTextIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function UploadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function TrashIconSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

export function isInlinePreviewable(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface UploadRow {
  key: string;
  filename: string;
  sizeBytes: number;
  percent: number;
  abort: () => void;
}

export function AttachmentsPanel({ slug, taskId }: AttachmentsPanelProps) {
  const { data: attachments } = useTaskAttachments(slug, taskId);
  const upload = useUploadAttachment(slug, "task", taskId);
  const remove = useDeleteAttachment(slug, "task", taskId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploads, setUploads] = useState<UploadRow[]>([]);

  const patchUpload = (key: string, patch: Partial<UploadRow>) => {
    setUploads((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const startUploads = (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setUploads((rows) => [...rows, { key, filename: file.name, sizeBytes: file.size, percent: 0, abort: () => {} }]);
      upload
        .mutateAsync({
          file,
          onProgress: (percent) => patchUpload(key, { percent }),
          onHandle: (handle) => patchUpload(key, { abort: handle.abort }),
        })
        .catch(() => {})
        .finally(() => setUploads((rows) => rows.filter((r) => r.key !== key)));
    }
  };

  const attachmentUrl = (a: Attachment) => `/api/attachments/${a.id}`;
  const uploaderLabel = (a: Attachment) => a.uploadedByLabel ?? a.uploadedBy ?? "Unknown";
  const rows = attachments ?? [];
  const totalBytes = rows.reduce((sum, a) => sum + a.sizeBytes, 0);

  return (
    <div
      className={cn(
        "mt-4 pt-4 border-t border-lx-border-subtle attachments-dropzone",
        dragActive && "active"
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        startUploads(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lx-text-muted shrink-0">
          <PaperclipIcon />
        </span>
        <span className="prop-label">Attachments</span>
        {rows.length > 0 && (
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
            {rows.length} {rows.length === 1 ? "file" : "files"} · {formatAttachmentSize(totalBytes)}
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost-accent btn-sm ml-auto"
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon size={14} />
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            startUploads(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {rows.length === 0 && uploads.length === 0 && (
        <div className="empty-box">
          <span className="text-lx-text-muted">
            <PaperclipIcon size={20} />
          </span>
          <span className="font-display text-base font-medium text-lx-text-primary">No attachments yet</span>
          <span className="text-xs text-lx-text-secondary">Drop files here or hit Upload — images and PDFs get inline previews</span>
        </div>
      )}

      {rows.map((a) => {
        const previewable = isInlinePreviewable(a.mimeType);
        return (
          <div key={a.id} className="github-issue-row">
            <div className="flex items-center gap-2 min-w-0">
              <span className="attachments-thumb">
                {previewable ? (
                  a.mimeType === "application/pdf" ? <FileTextIcon /> : <ImageThumbIcon />
                ) : (
                  <DownloadIcon />
                )}
              </span>
              <div className="flex flex-col min-w-0">
                <a
                  href={attachmentUrl(a)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-lx-text-link truncate"
                  title={previewable ? "Open preview" : "Download"}
                >
                  {a.filename}
                </a>
                <span className="font-micro text-2xs text-lx-text-muted">
                  {formatAttachmentSize(a.sizeBytes)} · {uploaderLabel(a)} · {formatAttachmentDate(a.createdAt)}
                </span>
              </div>
            </div>
            <Menu
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  className={cn("icon-btn", open && "active")}
                  title="More actions"
                  aria-label={`Actions for ${a.filename}`}
                  onClick={toggle}
                >
                  <KebabIcon />
                </button>
              )}
            >
              <a href={attachmentUrl(a)} target="_blank" rel="noreferrer" className="menu-item" role="menuitem">
                <DownloadIcon />
                Download
              </a>
              <div className="menu-separator" />
              <button
                type="button"
                className="menu-item danger"
                role="menuitem"
                disabled={remove.isPending}
                onClick={() => remove.mutateAsync(a.id).catch(() => {})}
              >
                <TrashIconSmall />
                Delete
              </button>
            </Menu>
          </div>
        );
      })}

      {uploads.map((u) => (
        <div key={u.key} className="github-issue-row">
          <div className="flex items-center gap-2 min-w-0">
            <span className="spinner" />
            <div className="flex flex-col min-w-0 flex-1" style={{ gap: 4 }}>
              <span className="text-sm font-medium text-lx-text-primary truncate">{u.filename}</span>
              <div className="flex items-center gap-2">
                <div className="attachments-progress">
                  <div className="attachments-progress-fill" style={{ width: `${u.percent}%` }} />
                </div>
                <span className="font-micro text-2xs text-lx-text-muted shrink-0">
                  {u.percent}% · {formatAttachmentSize(u.sizeBytes)}
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="Cancel upload"
            aria-label={`Cancel upload ${u.filename}`}
            onClick={() => u.abort()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
