export type MentionRefType = "task" | "wiki" | "milestone" | "swimlane" | "column" | "skill";

export interface MentionItem {
  refType: MentionRefType;
  refId: string;
  label: string;
  sublabel: string;
  insertToken?: string | undefined;
}

export const MENTION_SECTIONS: { refType: MentionRefType; label: string }[] = [
  { refType: "task", label: "Tasks" },
  { refType: "wiki", label: "Wiki" },
  { refType: "milestone", label: "Milestones" },
  { refType: "swimlane", label: "Swimlanes" },
  { refType: "column", label: "Columns" },
];

interface MentionEntityHit {
  id: string;
  name: string;
  slug: string;
  sublabel: string | null;
}

interface MentionsResponse {
  data?: {
    tasks?: { id: string; key: string; title: string }[];
    wikiPages?: { id: string; slug: string; title: string }[];
    milestones?: MentionEntityHit[];
    swimlanes?: MentionEntityHit[];
    columns?: MentionEntityHit[];
  };
}


// Query charset pinned by the contract: word-boundary characters only.
// Anything else (spaces, punctuation, attempteds like "java script") yields
// no results rather than hitting the endpoint.
const QUERY_RE = /^[A-Za-z0-9-]*$/;

export function isValidMentionQuery(query: string): boolean {
  return QUERY_RE.test(query);
}

export async function fetchMentionItems(slug: string, query: string): Promise<MentionItem[]> {
  // Empty query (bare "@") is allowed through: the server returns default
  // suggestions (recent tasks + wiki). Only invalid characters bail out.
  if (!isValidMentionQuery(query)) return [];
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/mentions?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as MentionsResponse;
  const tasks = (body.data?.tasks ?? []).map((t) => ({
    refType: "task" as const,
    refId: t.id,
    label: t.key,
    sublabel: t.title,
    insertToken: t.key,
  }));
  const wiki = (body.data?.wikiPages ?? []).map((w) => ({
    refType: "wiki" as const,
    refId: w.slug,
    label: w.title,
    sublabel: w.slug,
    insertToken: w.slug,
  }));
  // Milestones/swimlanes/columns have no slug column; the server's derived
  // `slug` is the mention token and also the popup's right-aligned sublabel.
  const entities = (rows: MentionEntityHit[] | undefined, refType: MentionRefType): MentionItem[] =>
    (rows ?? []).map((e) => ({
      refType,
      refId: e.id,
      label: e.name,
      sublabel: e.slug,
      insertToken: e.slug,
    }));
  // Server caps tasks+wiki at 8 combined and each entity array at 8; the
  // popup renders only non-empty sections in MENTION_SECTIONS order.
  return [
    ...tasks,
    ...wiki,
    ...entities(body.data?.milestones, "milestone"),
    ...entities(body.data?.swimlanes, "swimlane"),
    ...entities(body.data?.columns, "column"),
  ];
}

