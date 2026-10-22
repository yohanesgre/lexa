import type { DbDriver, LexaRow, SqlParam } from "./driver";
import { markdownToText } from "../../shared/markdown";
import { serializeLegacyTiptap } from "./legacy-tiptap";

export const MARKDOWN_AUDIT_FORMAT = "lexa-markdown-audit/v1" as const;
export type JournalRecord = { table_name: string; row_key: string; source_hash: string; target_hash: string };
export type MarkdownAuditRecord = { table_name: string; row_key: string; source_hash: string; target_hash: string };
export type MarkdownAuditBlocker = { table_name: string; row_key: string; reason: string };
export type MarkdownAuditReport = {
  format: typeof MARKDOWN_AUDIT_FORMAT;
  target_id: string;
  created_at: string;
  source_format: "tiptap-v1" | "migrating-markdown-v1" | "markdown-v1";
  records: MarkdownAuditRecord[];
  blockers: MarkdownAuditBlocker[];
};

type Row = LexaRow;
type Statement = { sql: string; params: SqlParam[] };
type Plan = { records: MarkdownAuditRecord[]; update: Statement; marker: Statement };
type JournalMap = Map<string, JournalRecord>;

const JOURNAL_SEPARATOR = "\u0000";
const keyOf = (table: string, rowKey: string): string => `${table}${JOURNAL_SEPARATOR}${rowKey}`;
const own = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}

async function sha256(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function all(db: DbDriver, sql: string, ...params: SqlParam[]): Promise<Row[]> {
  return db.prepare(sql).all(...params);
}

async function sourceFormat(db: DbDriver): Promise<MarkdownAuditReport["source_format"]> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").first<{ value: string }>("documents.format");
  if (row?.value === "tiptap-v1" || row?.value === "migrating-markdown-v1" || row?.value === "markdown-v1") return row.value;
  throw new Error(`Unsupported or missing documents.format (${row?.value ?? "uninitialized"}); apply schema migration 0030 first.`);
}

async function readJournal(db: DbDriver): Promise<JournalMap> {
  const rows = await all(db, "SELECT table_name, row_key, source_hash, target_hash FROM _markdown_migration");
  return new Map(rows.map((row) => {
    const item: JournalRecord = {
      table_name: stringValue(row.table_name, "journal.table_name"),
      row_key: stringValue(row.row_key, "journal.row_key"),
      source_hash: stringValue(row.source_hash, "journal.source_hash"),
      target_hash: stringValue(row.target_hash, "journal.target_hash"),
    };
    return [keyOf(item.table_name, item.row_key), item];
  }));
}

function deserializeJson(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new Error(`${label} contains malformed JSON`); }
  return record(parsed, label);
}

function serializeDoc(value: unknown, projectSlug: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected legacy TipTap document object");
  const source = JSON.stringify(value);
  if (source === undefined) throw new Error("could not encode legacy TipTap document");
  return serializeLegacyTiptap(source, { projectSlug });
}

function serializeLegacyField(table: string, source: string, projectSlug: string): string {
  // The old wiki schema used '{}' for its empty default and revision snapshots.
  if ((table === "wiki_pages.content" || table === "wiki_page_revisions.content") && source === "{}") return "";
  return serializeLegacyTiptap(source, { projectSlug });
}

async function currentMarkdown(
  table: string,
  rowKey: string,
  source: string,
  projectSlug: string,
  journal: JournalMap,
): Promise<string> {
  const entry = journal.get(keyOf(table, rowKey));
  if (!entry) return serializeLegacyField(table, source, projectSlug);
  const currentHash = await sha256(source);
  if (currentHash !== entry.target_hash) throw new Error(`journal CAS mismatch for ${table}/${rowKey}`);
  return source;
}

async function addFieldPlan(
  journal: JournalMap,
  records: MarkdownAuditRecord[],
  plans: Plan[],
  blockers: MarkdownAuditBlocker[],
  table: string,
  rowKey: string,
  source: string,
  target: string,
  update: Statement,
  markerSql = "INSERT INTO _markdown_migration (table_name, row_key, source_hash, target_hash) SELECT ?, ?, ?, ? WHERE changes() = 1 RETURNING row_key",
  markerValues?: string[][],
): Promise<void> {
  const sourceHash = await sha256(source);
  const targetHash = await sha256(target);
  const previous = journal.get(keyOf(table, rowKey));
  if (previous) {
    if (sourceHash !== previous.target_hash) {
      blockers.push({ table_name: table, row_key: rowKey, reason: "journal target hash does not match current source" });
      return;
    }
    records.push({ table_name: table, row_key: rowKey, source_hash: previous.source_hash, target_hash: previous.target_hash });
    return;
  }
  const item = { table_name: table, row_key: rowKey, source_hash: sourceHash, target_hash: targetHash };
  records.push(item);
  const values = markerValues ?? [[table, rowKey, sourceHash, targetHash]];
  const markerParams: SqlParam[] = values.flat();
  plans.push({ records: [item], update, marker: { sql: markerSql, params: markerParams } });
}

async function taskForRef(db: DbDriver, projectId: string, ref: string): Promise<Row> {
  const row = await db.prepare(
    "SELECT t.id, t.description, p.slug AS project_slug FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.project_id = ? AND (t.id = ? OR t.key = ?) LIMIT 1"
  ).first(projectId, ref, ref);
  if (!row) throw new Error(`task reference ${ref} no longer resolves in proposal project`);
  return row;
}

async function wikiForSlug(db: DbDriver, projectId: string, slug: string): Promise<Row> {
  const row = await db.prepare(
    "SELECT id, content, project_id FROM wiki_pages WHERE project_id = ? AND slug = ? LIMIT 1"
  ).first(projectId, slug);
  if (!row) throw new Error(`wiki page ${slug} no longer resolves in proposal project`);
  return row;
}

function ownsLegacyDoc(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(ownsLegacyDoc);
  if (typeof value !== "object" || value === null) return false;
  if ("type" in value && value.type === "doc") return true;
  return Object.values(value).some(ownsLegacyDoc);
}

async function convertProposal(
  db: DbDriver,
  journal: JournalMap,
  row: Row,
  projectSlug: string,
): Promise<{ args: string; diff: string; argsSource: string; diffSource: string } | null> {
  const id = stringValue(row.id, "proposal.id");
  const argsSource = stringValue(row.args, `proposal ${id} args`);
  const diffSource = stringValue(row.diff, `proposal ${id} diff`);
  const args = deserializeJson(argsSource, `proposal ${id} args`);
  const diff = deserializeJson(diffSource, `proposal ${id} diff`);
  const tool = stringValue(row.tool_name, `proposal ${id} tool_name`);
  let changed = false;
  let currentTaskMarkdown: string | undefined;
  let currentWikiMarkdown: string | undefined;
  const projectId = stringValue(row.project_id, `proposal ${id} project_id`);
  const argsHasDoc = (field: string): boolean => own(args, field) && args[field] !== undefined;
  const convertArg = (field: string): string => {
    const converted = serializeDoc(args[field], projectSlug);
    args[field] = converted;
    changed = true;
    return converted;
  };

  switch (tool) {
    case "create_task": {
      if (argsHasDoc("description")) {
        const markdown = convertArg("description");
        const fields = record(diff.fields, `proposal ${id} diff.fields`);
        if (!own(fields, "description")) throw new Error("create_task diff has no description field for its document argument");
        fields.description = markdown;
        changed = true;
      }
      break;
    }
    case "update_task": {
      const changes = diff.changes;
      if (!Array.isArray(changes)) throw new Error("update_task diff.changes must be an array");
      const descriptionChanges = changes.filter((change) => {
        const item = record(change, `proposal ${id} diff change`);
        return item.field === "description";
      });
      if (argsHasDoc("description") !== (descriptionChanges.length > 0)) {
        throw new Error("update_task description args and diff disagree");
      }
      if (descriptionChanges.length > 0) {
        const ref = stringValue(args.ref, `proposal ${id} args.ref`);
        const task = await taskForRef(db, projectId, ref);
        const taskId = stringValue(task.id, "task.id");
        currentTaskMarkdown = await currentMarkdown(
          "tasks.description", taskId, stringValue(task.description, "task.description"),
          stringValue(task.project_slug, "task.project_slug"), journal,
        );
        const markdown = convertArg("description");
        for (const change of descriptionChanges) {
          const item = record(change, `proposal ${id} diff change`);
          item.before = currentTaskMarkdown;
          item.after = markdown;
        }
      }
      break;
    }
    case "add_comment": {
      if (!argsHasDoc("body")) throw new Error("add_comment proposal has no body document");
      const markdown = convertArg("body");
      assertCommentMarkdown(markdown);
      diff.bodyText = markdown;
      changed = true;
      break;
    }
    case "create_wiki_page": {
      if (!argsHasDoc("content")) throw new Error("create_wiki_page proposal has no content document");
      const markdown = convertArg("content");
      diff.bodyText = markdown;
      changed = true;
      break;
    }
    case "edit_wiki_page": {
      if (!argsHasDoc("content")) throw new Error("edit_wiki_page proposal has no content document");
      const slug = stringValue(args.slug, `proposal ${id} args.slug`);
      const page = await wikiForSlug(db, projectId, slug);
      currentWikiMarkdown = await currentMarkdown(
        "wiki_pages.content", stringValue(page.id, "wiki page.id"),
        stringValue(page.content, "wiki page.content"), projectSlug, journal,
      );
      const markdown = convertArg("content");
      diff.beforeText = currentWikiMarkdown;
      diff.afterText = markdown;
      changed = true;
      break;
    }
    default:
      break;
  }
  if (ownsLegacyDoc(args) || ownsLegacyDoc(diff)) throw new Error(`tool ${tool} has unrecognized embedded TipTap content`);
  if (!changed) return null;
  return { args: JSON.stringify(args), diff: JSON.stringify(diff), argsSource, diffSource };
}

function asSource(row: Row, key: string, label: string): string {
  return stringValue(row[key], label);
}

function assertCommentMarkdown(body: string): void {
  if (!markdownToText(body).trim()) throw new Error("comment conversion has no required text");
  if (JSON.stringify(body).length > 65_536) throw new Error("converted comment exceeds the 65,536-character limit");
}

function pushBlocker(blockers: MarkdownAuditBlocker[], table: string, key: string, error: unknown): void {
  blockers.push({ table_name: table, row_key: key, reason: error instanceof Error ? error.message : String(error) });
}

export async function auditMarkdownUpgrade(db: DbDriver, targetId: string): Promise<MarkdownAuditReport> {
  const format = await sourceFormat(db);
  const report: MarkdownAuditReport = {
    format: MARKDOWN_AUDIT_FORMAT,
    target_id: targetId,
    created_at: new Date().toISOString(),
    source_format: format,
    records: [],
    blockers: [],
  };
  if (format === "markdown-v1") return report;
  const journal = await readJournal(db);
  const plans: Plan[] = [];
  const blockers = report.blockers;
  const records = report.records;

  const simpleRows: Array<{ table: string; sql: string; sourceKey: string; update: (row: Row, source: string, target: string) => Statement; comment?: boolean }> = [
    { table: "tasks.description", sql: "SELECT t.id AS row_key, t.description AS source, p.slug AS project_slug FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY t.id", sourceKey: "source", update: (r, s, t) => ({ sql: "UPDATE tasks SET description = ? WHERE id = ? AND description = ? RETURNING id", params: [t, stringValue(r.row_key, "task.id"), s] }) },
    { table: "wiki_pages.content", sql: "SELECT w.id AS row_key, w.content AS source, w.content_text AS content_text, p.slug AS project_slug FROM wiki_pages w JOIN projects p ON p.id = w.project_id ORDER BY w.id", sourceKey: "source", update: (r, s, t) => ({ sql: "UPDATE wiki_pages SET content = ?, content_text = ? WHERE id = ? AND content = ? AND content_text = ? RETURNING id", params: [t, markdownToText(t), stringValue(r.row_key, "wiki_page.id"), s, stringValue(r.content_text, "wiki_page.content_text")] }) },
    { table: "wiki_page_revisions.content", sql: "SELECT r.id AS row_key, r.content AS source, r.content_text AS content_text, p.slug AS project_slug FROM wiki_page_revisions r JOIN wiki_pages w ON w.id = r.page_id JOIN projects p ON p.id = w.project_id ORDER BY r.id", sourceKey: "source", update: (r, s, t) => ({ sql: "UPDATE wiki_page_revisions SET content = ?, content_text = ? WHERE id = ? AND content = ? AND content_text = ? RETURNING id", params: [t, markdownToText(t), stringValue(r.row_key, "wiki_revision.id"), s, stringValue(r.content_text, "wiki_revision.content_text")] }) },
    { table: "task_comments.body", sql: "SELECT c.id AS row_key, c.body AS source, p.slug AS project_slug FROM task_comments c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id ORDER BY c.id", sourceKey: "source", comment: true, update: (r, s, t) => ({ sql: "UPDATE task_comments SET body = ? WHERE id = ? AND body = ? RETURNING id", params: [t, Number(r.row_key), s] }) },
  ];

  for (const table of simpleRows) {
    let rows: Row[];
    try { rows = await all(db, table.sql); }
    catch (error) { pushBlocker(blockers, table.table, "*", error); continue; }
    for (const row of rows) {
      const key = String(row.row_key);
      const source = asSource(row, table.sourceKey, `${table.table}/${key}`);
      try {
        const sourceHash = await sha256(source);
        const previous = journal.get(keyOf(table.table, key));
        if (previous) {
          if (sourceHash !== previous.target_hash) throw new Error("journal target hash does not match current source");
          if (table.comment) assertCommentMarkdown(source);
          records.push({ table_name: table.table, row_key: key, source_hash: previous.source_hash, target_hash: previous.target_hash });
          continue;
        }
        const target = serializeLegacyField(table.table, source, stringValue(row.project_slug, "project.slug"));
        if (table.comment) assertCommentMarkdown(target);
        await addFieldPlan(journal, records, plans, blockers, table.table, key, source, target, table.update(row, source, target));
      } catch (error) { pushBlocker(blockers, table.table, key, error); }
    }
  }

  let proposals: Row[] = [];
  try {
    proposals = await all(db, "SELECT w.id, w.project_id, w.tool_name, w.args, w.diff, p.slug AS project_slug FROM assistant_pending_writes w JOIN projects p ON p.id = w.project_id WHERE w.status = 'pending' ORDER BY w.id");
  } catch (error) { pushBlocker(blockers, "assistant_pending_writes", "*", error); }
  for (const row of proposals) {
    const id = stringValue(row.id, "proposal.id");
    const argsTable = "assistant_pending_writes.args";
    const diffTable = "assistant_pending_writes.diff";
    try {
      const oldArgs = asSource(row, "args", `proposal ${id} args`);
      const oldDiff = asSource(row, "diff", `proposal ${id} diff`);
      const argsJournal = journal.get(keyOf(argsTable, id));
      const diffJournal = journal.get(keyOf(diffTable, id));
      if (Boolean(argsJournal) !== Boolean(diffJournal)) throw new Error("proposal args/diff journal entries are not atomic");
      if (argsJournal && diffJournal) {
        if (await sha256(oldArgs) !== argsJournal.target_hash || await sha256(oldDiff) !== diffJournal.target_hash) {
          throw new Error("proposal journal target hash does not match current source");
        }
        if (row.tool_name === "add_comment") {
          const resumedArgs = deserializeJson(oldArgs, `proposal ${id} args`);
          assertCommentMarkdown(stringValue(resumedArgs.body, `proposal ${id} args.body`));
        }
        records.push({ table_name: argsTable, row_key: id, source_hash: argsJournal.source_hash, target_hash: argsJournal.target_hash });
        records.push({ table_name: diffTable, row_key: id, source_hash: diffJournal.source_hash, target_hash: diffJournal.target_hash });
        continue;
      }
      const converted = await convertProposal(db, journal, row, stringValue(row.project_slug, "project.slug"));
      if (!converted) continue;
      const argsTargetHash = await sha256(converted.args);
      const diffTargetHash = await sha256(converted.diff);
      const argsSourceHash = await sha256(converted.argsSource);
      const diffSourceHash = await sha256(converted.diffSource);
      const argsRecord = { table_name: argsTable, row_key: id, source_hash: argsSourceHash, target_hash: argsTargetHash };
      const diffRecord = { table_name: diffTable, row_key: id, source_hash: diffSourceHash, target_hash: diffTargetHash };
      records.push(argsRecord, diffRecord);
      const markerSql = "INSERT INTO _markdown_migration (table_name, row_key, source_hash, target_hash) SELECT ?, ?, ?, ? WHERE changes() = 1 UNION ALL SELECT ?, ?, ?, ? WHERE changes() = 1 RETURNING row_key";
      plans.push({
        records: [argsRecord, diffRecord],
        update: {
          sql: "UPDATE assistant_pending_writes SET args = ?, diff = ? WHERE id = ? AND status = 'pending' AND args = ? AND diff = ? RETURNING id",
          params: [converted.args, converted.diff, id, oldArgs, oldDiff],
        },
        marker: { sql: markerSql, params: [argsTable, id, argsSourceHash, argsTargetHash, diffTable, id, diffSourceHash, diffTargetHash] },
      });
    } catch (error) { pushBlocker(blockers, "assistant_pending_writes.args/diff", id, error); }
  }
  report.records.sort((a, b) => a.table_name.localeCompare(b.table_name) || a.row_key.localeCompare(b.row_key));
  report.blockers.sort((a, b) => a.table_name.localeCompare(b.table_name) || a.row_key.localeCompare(b.row_key));
  Object.defineProperty(report, "plans", { value: plans });
  return report;
}

function compareRecords(left: MarkdownAuditRecord[], right: MarkdownAuditRecord[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index]!;
    return item.table_name === other.table_name && item.row_key === other.row_key &&
      item.source_hash === other.source_hash && item.target_hash === other.target_hash;
  });
}

async function verifyWikiProjections(db: DbDriver): Promise<void> {
  const pages = await all(db, "SELECT id, content, content_text FROM wiki_pages ORDER BY id");
  for (const row of pages) {
    const expected = markdownToText(stringValue(row.content, "wiki_page.content"));
    if (expected !== stringValue(row.content_text, "wiki_page.content_text")) throw new Error(`wiki content_text mismatch for page ${String(row.id)}`);
  }
  const revisions = await all(db, "SELECT id, content, content_text FROM wiki_page_revisions ORDER BY id");
  for (const row of revisions) {
    const expected = markdownToText(stringValue(row.content, "wiki_revision.content"));
    if (expected !== stringValue(row.content_text, "wiki_revision.content_text")) throw new Error(`wiki revision content_text mismatch for revision ${String(row.id)}`);
  }
  await db.prepare("INSERT INTO wiki_fts(wiki_fts, rank) VALUES ('integrity-check', 1)").run();
}

export async function applyMarkdownUpgrade(
  db: DbDriver,
  report: MarkdownAuditReport,
  targetId: string,
  batchSize: number,
): Promise<{ updated: number; alreadyMarkdown: boolean }> {
  if (report.format !== MARKDOWN_AUDIT_FORMAT) throw new Error("unsupported Markdown audit report format");
  if (report.target_id !== targetId) throw new Error("audit report target does not match selected database");
  if (report.blockers.length > 0) throw new Error("audit report contains blockers; no writes performed");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error("batch size must be an integer from 1 through 50");
  const initialFormat = await sourceFormat(db);
  if (initialFormat === "markdown-v1") return { updated: 0, alreadyMarkdown: true };
  const current = await auditMarkdownUpgrade(db, targetId);
  if (current.blockers.length > 0 || !compareRecords(current.records, report.records)) {
    throw new Error("database content changed since audit; no writes performed; rerun audit");
  }
  if (initialFormat === "tiptap-v1") {
    const result = await db.prepare("UPDATE settings SET value = 'migrating-markdown-v1', updated_at = datetime('now') WHERE key = 'documents.format' AND value = 'tiptap-v1' RETURNING value").all();
    if (result.length !== 1) throw new Error("could not claim documents.format migration state; rerun audit");
  }
  let updated = 0;
  const plans = (Object.getOwnPropertyDescriptor(current, "plans")?.value ?? []) as Plan[];
  for (let offset = 0; offset < plans.length; offset += batchSize) {
    const chunk = plans.slice(offset, offset + batchSize);
    const statements = chunk.flatMap((plan) => [plan.update, plan.marker]);
    const result = await db.batch(statements);
    for (let index = 0; index < chunk.length; index += 1) {
      if (result[index * 2]?.results.length !== 1) throw new Error(`source compare-and-swap conflict in batch at ${chunk[index]!.records[0]!.table_name}/${chunk[index]!.records[0]!.row_key}; rerun audit`);
      if (result[index * 2 + 1]?.results.length !== chunk[index]!.records.length) throw new Error(`journal marker write failed for ${chunk[index]!.records[0]!.table_name}/${chunk[index]!.records[0]!.row_key}`);
      updated += chunk[index]!.records.length;
    }
  }
  const after = await auditMarkdownUpgrade(db, targetId);
  if (after.blockers.length > 0 || !compareRecords(after.records, report.records)) throw new Error("post-apply journal verification failed; format remains migrating-markdown-v1");
  await verifyWikiProjections(db);
  const finalized = await db.prepare("UPDATE settings SET value = 'markdown-v1', updated_at = datetime('now') WHERE key = 'documents.format' AND value = 'migrating-markdown-v1' RETURNING value").all();
  if (finalized.length !== 1) throw new Error("could not finalize documents.format; rerun apply from the same clean audit");
  return { updated, alreadyMarkdown: false };
}

export function parseMarkdownAudit(value: unknown): MarkdownAuditReport {
  const root = record(value, "audit report");
  if (root.format !== MARKDOWN_AUDIT_FORMAT || typeof root.target_id !== "string" ||
      typeof root.created_at !== "string" || !["tiptap-v1", "migrating-markdown-v1", "markdown-v1"].includes(String(root.source_format)) ||
      !Array.isArray(root.records) || !Array.isArray(root.blockers)) throw new Error("invalid Markdown audit report");
  const records = root.records.map((item) => {
    const entry = record(item, "audit record");
    return {
      table_name: stringValue(entry.table_name, "audit record table_name"),
      row_key: stringValue(entry.row_key, "audit record row_key"),
      source_hash: stringValue(entry.source_hash, "audit record source_hash"),
      target_hash: stringValue(entry.target_hash, "audit record target_hash"),
    };
  });
  const blockers = root.blockers.map((item) => {
    const entry = record(item, "audit blocker");
    return {
      table_name: stringValue(entry.table_name, "audit blocker table_name"),
      row_key: stringValue(entry.row_key, "audit blocker row_key"),
      reason: stringValue(entry.reason, "audit blocker reason"),
    };
  });
  return {
    format: MARKDOWN_AUDIT_FORMAT,
    target_id: root.target_id,
    created_at: root.created_at,
    source_format: root.source_format as MarkdownAuditReport["source_format"],
    records,
    blockers,
  };
}
