import { useRef, useState } from "react";
import { ImagePlus, Plus, X } from "lucide-react";

export interface HeraldImage {
  id: string;
  file: File;
  previewUrl: string;
}

export interface HeraldImageCaps {
  maxCount: number;
  maxBytesEach?: number;
  maxTotalBytes?: number;
}

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function extLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "img";
}

function rejectionFor(file: File, current: HeraldImage[], caps: HeraldImageCaps): string | null {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return `Max ${caps.maxCount} images per message · png/jpeg/gif/webp`;
  }
  if (caps.maxBytesEach !== undefined && file.size > caps.maxBytesEach) {
    return `Max ${caps.maxCount} images per message · ${Math.round(caps.maxBytesEach / (1024 * 1024))}MB each · png/jpeg/gif/webp`;
  }
  if (caps.maxTotalBytes !== undefined) {
    const total = current.reduce((sum, img) => sum + img.file.size, 0);
    if (total + file.size > caps.maxTotalBytes) {
      return `Images exceed the ${(caps.maxTotalBytes / (1024 * 1024)).toFixed(caps.maxTotalBytes % (1024 * 1024) === 0 ? 0 : 1)}MB total request limit`;
    }
  }
  if (current.length >= caps.maxCount) {
    return `Max ${caps.maxCount} images per message · png/jpeg/gif/webp`;
  }
  return null;
}

// Shared by click-pick and clipboard paste paths.
export function acceptImageFiles(files: File[], current: HeraldImage[], caps: HeraldImageCaps): { images: HeraldImage[]; rejection: string | null } {
  let rejection: string | null = null;
  const next = [...current];
  for (const file of files) {
    const reject = rejectionFor(file, next, caps);
    if (reject) {
      rejection = reject;
      continue;
    }
    next.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) });
  }
  return { images: next, rejection };
}

// Image attach affordance (herald-popover.html State 1 + State 5 detail,
// herald-chat.html composer): pick or paste, thumbnails with remove ×,
// dashed add tile, caps enforced client-side with inline rejection.
export function HeraldImageAttach({ images, onChange, caps, hint, compact }: {
  images: HeraldImage[];
  onChange: (images: HeraldImage[]) => void;
  caps: HeraldImageCaps;
  hint: string;
  // Chat composer variant: bare icon button while empty (herald-chat.html
  // composer-footer).
  compact?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rejection, setRejection] = useState<string | null>(null);

  const acceptFiles = (files: FileList | File[]) => {
    const result = acceptImageFiles(Array.from(files), images, caps);
    setRejection(result.rejection);
    onChange(result.images);
  };

  const removeImage = (id: string) => {
    const target = images.find((img) => img.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    onChange(images.filter((img) => img.id !== id));
  };

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        multiple
        hidden
        aria-label="Attach images"
        onChange={(e) => {
          if (e.target.files) acceptFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {images.length === 0 && compact ? (
        <button
          type="button"
          className="btn btn-ghost btn-icon-sm"
          title="Attach images — or paste into the composer"
          aria-label="Attach images"
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus size={14} strokeWidth={1.5} />
        </button>
      ) : images.length === 0 ? (
        <div className="flex items-center justify-between" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={12} strokeWidth={1.5} />
            Attach images
          </button>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{hint}</span>
        </div>
      ) : (
        <>
          <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
            Attachments <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>{images.length} / {caps.maxCount}</span>
          </span>
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            {images.map((img) => (
              <div key={img.id} style={{ position: "relative", width: 56, height: 56, border: "1px solid var(--lx-border-default)", borderRadius: 6, background: "var(--lx-surface-card-hover)", overflow: "hidden" }}>
                <img src={img.previewUrl} alt={img.file.name} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                <button
                  type="button"
                  className="btn btn-ghost"
                  title="Remove image"
                  aria-label={`Remove ${img.file.name}`}
                  style={{ position: "absolute", top: -1, right: -1, width: 16, height: 16, padding: 0, border: "none", borderRadius: "0 6px 0 6px", background: "rgba(12,11,9,0.75)", color: "var(--lx-text-secondary)" }}
                  onClick={() => removeImage(img.id)}
                >
                  <X size={9} strokeWidth={2} />
                </button>
                <span className="font-micro text-2xs text-lx-text-muted" style={{ position: "absolute", left: 4, bottom: 2 }}>{extLabel(img.file.name)}</span>
              </div>
            ))}
            {images.length < caps.maxCount && (
              <button
                type="button"
                className="btn btn-ghost"
                title="Add images — click to pick or paste"
                aria-label="Add images"
                style={{ width: 56, height: 56, padding: 0, borderStyle: "dashed", color: "var(--lx-text-muted)", justifyContent: "center" }}
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus size={16} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </>
      )}
      {rejection && <div className="field-hint field-hint-danger" style={{ marginTop: 6 }}>{rejection}</div>}
    </div>
  );
}
