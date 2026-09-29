// The leading `$` must sit at a boundary the client also honors, so a token
// embedded in a word (`a$b`) parses server-side only when it renders as a
// chip client-side (app/lib/tokenizeTranscript.tsx).
const SKILL_TOKEN_RE = /(?<![A-Za-z0-9])\$([A-Za-z][A-Za-z0-9-]*)/g;

export function skillToken(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function parseSkillTokens(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(SKILL_TOKEN_RE)) {
    const t = skillToken(m[1]!);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
