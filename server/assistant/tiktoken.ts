import type { Tiktoken } from "js-tiktoken/lite";

let encoderPromise: Promise<Tiktoken> | null = null;

function loadEncoder(): Promise<Tiktoken> {
  encoderPromise ??= (async () => {
    const { Tiktoken } = await import("js-tiktoken/lite");
    const { default: cl100kBaseRanks } = await import("js-tiktoken/ranks/cl100k_base");
    return new Tiktoken(cl100kBaseRanks);
  })();
  return encoderPromise;
}

export async function estimateTokens(text: string): Promise<number> {
  if (!text) return 0;
  try {
    const enc = await loadEncoder();
    return enc.encode(text).length;
  } catch {
    return 0; // caller falls back to chars/4 (gateway.service.ts:528-531)
  }
}
