// Heuristic token estimate for the cost log's missing-usage fallback. This is
// never authoritative: the provider's usage wins whenever it reports one, and
// the caller keeps the `estimated` flag. `tokenx` is a zero-dependency,
// synchronous estimator, so it adds a few kB instead of the 1.07 MB encoder
// ranks chunk `js-tiktoken` needed.
import { estimateTokenCount } from "tokenx";

export async function estimateTokens(text: string): Promise<number> {
  if (!text) return 0;
  try {
    return estimateTokenCount(text);
  } catch {
    return 0; // 0 = unknown; the caller estimates from text length (chars/4)
  }
}
