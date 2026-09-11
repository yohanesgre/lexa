// Regression: String.prototype.replace expands `$$`, `$&`, `` $` ``, `$'` and
// `$n` in a string replacement. The bundled Hearth daemon contains Effect's
// escapeRegExp body (`"\$&"`), so a string replacement corrupted the embed and
// `bun run compile:cli` emitted an unparseable packed.ts. packedEmbed must use
// a function replacer so the payload survives verbatim.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PACKED_STUB, packedEmbed } from "./packed-embed";

const PAYLOADS = [
  // The original corruption: `$&` (whole match) inside the daemon bundle.
  'const ESCAPED = "\\$&";',
  // Every `$`-pattern the spec form expands.
  "dollar-amp $& dollar-double $$ backtick $` quote $'",
  "capture groups $1 $2 and named $<name>",
  // Realistic bundle noise around the payload.
  'var re = /[.*+?^${}()|[\\]\\\\]/g; str.replace(re, "\\\\$&");',
];

function evaluate(generated: string): string {
  const body = generated.replace("export const DAEMON_SOURCE", "const DAEMON_SOURCE");
  return new Function(`${body}\nreturn DAEMON_SOURCE;`)() as string;
}

describe("packedEmbed", () => {
  it("preserves `$&`, `$$`, `` $` ``, `$'` and `$n` verbatim", () => {
    for (const payload of PAYLOADS) {
      const generated = packedEmbed(payload);
      // Raw text carries the exact JSON literal (no pattern expansion).
      expect(generated).toContain(`export const DAEMON_SOURCE = ${JSON.stringify(payload)};`);
      // Evaluating the generated module yields the identical payload.
      expect(evaluate(generated)).toBe(payload);
    }
  });

  it("emits parseable TypeScript for an arbitrary daemon bundle", () => {
    const generated = packedEmbed(PAYLOADS.join("\n"));
    expect(() => evaluate(generated)).not.toThrow();
    expect(evaluate(generated)).toBe(PAYLOADS.join("\n"));
  });

  it("keeps the committed stub in sync with the generated helper", () => {
    const onDisk = readFileSync(new URL("./packed.ts", import.meta.url), "utf-8");
    expect(PACKED_STUB).toBe(onDisk);
  });
});
