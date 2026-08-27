const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const MAX_LEN = 6;

export function generateTaskKey(slug: string, taken: (candidate: string) => boolean): string {
  const words = slug.toLowerCase().split("-").filter(Boolean);
  const lastWord = words[words.length - 1] ?? "";
  const letters = lastWord.split("");
  let base: string;
  if (words.length > 1) {
    base = words.filter((w) => !/^\d/.test(w)).slice(0, 3).map((w) => w[0]!).join("").toUpperCase();
  } else {
    const first = letters[0]! ?? "p";
    const consonants = letters.slice(1).filter((c) => !VOWELS.has(c));
    base = (first + consonants.join("")).toUpperCase().slice(0, 3);
  }
  if (base.length < 2) base = (base + lastWord.toUpperCase()).slice(0, 2);
  let candidate = base;
  const extension = lastWord.slice(1).split("");
  for (let i = 0; i < extension.length && taken(candidate); i++) {
    candidate = (base + extension.slice(0, i + 1).join("")).toUpperCase().slice(0, MAX_LEN);
  }
  if (taken(candidate)) {
    let n = 2;
    while (taken(`${base}${n}`)) n++;
    candidate = `${base}${n}`;
  }
  return candidate;
}

export function parseTaskKey(raw: string): { prefix: string; number: number } | null {
  const m = raw.toUpperCase().match(/^([A-Z0-9]{2,6})-(\d+)$/);
  if (!m) return null;
  return { prefix: m[1]!, number: Number(m[2]!) };
}