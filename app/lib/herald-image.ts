export interface HeraldImage {
  id: string;
  file: File;
  previewUrl: string;
}

export interface HeraldImageCaps {
  maxCount: number;
  maxBytesEach?: number | undefined;
  maxTotalBytes?: number | undefined;
}

export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

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
