import type { Tiktoken } from "js-tiktoken/lite";

let encoderPromise: Promise<Tiktoken> | null = null;
let loadWarned = false;

function loadEncoder(): Promise<Tiktoken> {
  encoderPromise ??= (async () => {
    const { Tiktoken } = await import("js-tiktoken/lite");
    const { default: cl100kBaseRanks } = await import("js-tiktoken/ranks/cl100k_base");
    return new Tiktoken(cl100kBaseRanks);
  })().catch((err: unknown) => {
    encoderPromise = null;
    throw err;
  });
  return encoderPromise;
}

export async function estimateTokens(text: string): Promise<number> {
  if (!text) return 0;
  try {
    const enc = await loadEncoder();
    return enc.encode(text).length;
  } catch (err) {
    if (!loadWarned) {
      loadWarned = true;
      console.warn("[tiktoken] token estimate failed; cost estimates fall back to chars/4", err);
    }
    return 0; // 0 = unknown; the caller estimates from text length
  }
}
