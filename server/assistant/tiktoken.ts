import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return enc.encode(text).length;
}
