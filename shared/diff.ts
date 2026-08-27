import type { TipTapDoc, TipTapNode } from "./types";

// Git-style unified diff for the Hearth review-in-editor flow.
// The document is never mutated while the diff is shown: the original side is
// the selection's structure (plain text, list markers kept, no markdown
// syntax), the new side is the AI result parsed back to the same form.

export type DiffSpan =
  | { kind: "same"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string };

export type DiffLine = {
  kind: "del" | "add";
  text: string;
  spans: DiffSpan[];
};

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffResult {
  oldText: string;
  newText: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

type DiffNode = TipTapNode;

// Canonical plain-text form used for diffing: headings bare (no # markers),
// list items prefixed with "- ", code blocks bare (no fences), blocks joined
// with "\n". Matches the hearth-review wireframe's rendering.
export function docToDiffText(doc: TipTapDoc): string {
  try {
    if (!doc || !Array.isArray(doc.content)) return "";
    return collectDiffLines(doc.content, "").join("\n");
  } catch {
    return "";
  }
}

function collectDiffLines(nodes: DiffNode[] | undefined, prefix: string): string[] {
  if (!nodes) return [];
  const lines: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
      case "paragraph": {
        const text = prefix + renderDiffInline(node.content);
        if (text !== "") lines.push(text);
        break;
      }
      case "listItem":
        lines.push(...collectDiffLines(node.content, `${prefix}- `));
        break;
      case "taskItem": {
        const marker = node.attrs?.checked ? "- [x] " : "- [ ] ";
        lines.push(...collectDiffLines(node.content, prefix + marker));
        break;
      }
      case "blockquote":
        lines.push(...collectDiffLines(node.content, `${prefix}> `));
        break;
      case "codeBlock": {
        const text = prefix + renderDiffInline(node.content);
        if (text !== "") lines.push(text);
        break;
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        lines.push(...collectDiffLines(node.content, prefix));
        break;
      case "horizontalRule":
        lines.push(prefix + "---");
        break;
      case "text":
        lines.push(prefix + (node.text ?? ""));
        break;
      default:
        lines.push(...collectDiffLines(node.content, prefix));
    }
  }
  return lines;
}

function renderDiffInline(nodes: DiffNode[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.text ?? "";
    else if (node.type === "hardBreak") out += "\n";
    else out += renderDiffInline(node.content);
  }
  return out;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { kind: "equal" | "del" | "add"; a: number; b: number };

// LCS over lines/tokens (suffix DP, tie-break deletes first like git).
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const ai = a[i]!;
      const bj = b[j]!;
      const diag = dp[i + 1]![j + 1]!;
      const down = dp[i + 1]![j]!;
      const right = dp[i]![j + 1]!;
      dp[i]![j] = ai === bj ? diag + 1 : Math.max(down, right);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]! === b[j]!) {
      ops.push({ kind: "equal", a: i, b: j });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", a: i, b: -1 });
      i++;
    } else {
      ops.push({ kind: "add", a: -1, b: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", a: i, b: -1 });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "add", a: -1, b: j });
    j++;
  }
  return ops;
}

export function diffText(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = lcsOps(a, b);

  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let oldBefore = 0;
  let newBefore = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind === "equal") {
      oldBefore++;
      newBefore++;
      continue;
    }
    const start = i;
    while (i < ops.length && ops[i]!.kind !== "equal") i++;
    const run = ops.slice(start, i);
    i--;

    const delA = run.filter((o) => o.kind === "del");
    const addB = run.filter((o) => o.kind === "add");
    additions += addB.length;
    deletions += delA.length;

    const oldStart = delA.length > 0 ? delA[0]!.a + 1 : oldBefore + 1;
    const newStart = addB.length > 0 ? addB[0]!.b + 1 : newBefore + 1;

    // Word-level spans: pair the i-th deleted line with the i-th added line
    // only when the counts match (unbalanced hunks render plain, like the
    // wireframe's second hunk).
    const delLines = run.filter((o) => o.kind === "del");
    const addLines = run.filter((o) => o.kind === "add");
    const pairWordDiff = delLines.length === addLines.length && delLines.length > 0;

    const lines: DiffLine[] = [];
    for (const o of run) {
      if (o.kind === "del") {
        const text = a[o.a] ?? "";
        const pairIdx = delLines.indexOf(o);
        const paired = pairWordDiff ? addLines[pairIdx] : undefined;
        const spans = pairWordDiff && paired ? wordSpans(text, b[paired.b] ?? "").del : [];
        lines.push({ kind: "del", text, spans });
      } else {
        const text = b[o.b] ?? "";
        const pairIdx = addLines.indexOf(o);
        const paired = pairWordDiff ? delLines[pairIdx] : undefined;
        const spans = pairWordDiff && paired ? wordSpans(a[paired.a] ?? "", text).add : [];
        lines.push({ kind: "add", text, spans });
      }
    }

    hunks.push({ oldStart, oldLines: delLines.length, newStart, newLines: addLines.length, lines });

    for (const o of run) {
      if (o.kind === "del") oldBefore++;
      else newBefore++;
    }
  }

  return { oldText, newText, additions, deletions, hunks };
}

// Words and punctuation runs (whitespace is not tokenized — it is reattached
// to the following span by reconstructing the original substring, which is
// how git --word-diff keeps spacing inside changed regions).
type Token = { text: string; start: number; end: number };

const TOKEN_RE = /([A-Za-z0-9_]+)|([^\sA-Za-z0-9_]+)/g;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    tokens.push({ text: match[0]!, start: match.index ?? 0, end: (match.index ?? 0) + match[0]!.length });
  }
  return tokens;
}

function wordSpans(aText: string, bText: string): { del: DiffSpan[]; add: DiffSpan[] } {
  const a = tokenize(aText);
  const b = tokenize(bText);
  const ops = lcsOps(a.map((t) => t.text), b.map((t) => t.text));
  const del: DiffSpan[] = [];
  const add: DiffSpan[] = [];
  let i = 0;
  while (i < ops.length) {
    const op0 = ops[i]!;
    const kind = op0.kind;
    let j = i;
    while (j < ops.length && ops[j]!.kind === kind) j++;
    const first = ops[i]!;
    const last = ops[j - 1]!;
    if (kind === "del") {
      const sTok = a[first.a]!;
      const eTok = a[last.a]!;
      del.push({ kind: "del", text: aText.slice(wsStart(aText, sTok.start), eTok.end) });
    } else if (kind === "add") {
      const sTok = b[first.b]!;
      const eTok = b[last.b]!;
      add.push({ kind: "add", text: bText.slice(wsStart(bText, sTok.start), eTok.end) });
    } else {
      const sTok = a[first.a]!;
      const eTok = a[last.a]!;
      const text = aText.slice(wsStart(aText, sTok.start), eTok.end);
      del.push({ kind: "same", text });
      add.push({ kind: "same", text });
    }
    i = j;
  }
  return { del, add };
}

function wsStart(text: string, index: number): number {
  let s = index;
  while (s > 0 && /\s/.test(text[s - 1] ?? "")) s--;
  return s;
}
