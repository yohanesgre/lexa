import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { DbError, ConstraintViolation } from "../db/database";
import {
  ProviderAuthFailed,
  ProviderUnreachable,
  AssistantGenerationFailed,
  errorToStatus,
  errorResponse,
  errorMessage,
  errorDetails,
  errorCodeMap,
} from "./errors";

const RAW = "UNIQUE constraint failed: tasks.column_id, tasks.position";
const asCatalogError = (e: object) => e as unknown as { _tag: string } & Record<string, unknown>;

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const API_MD = fileURLToPath(new URL("../../docs/API.md", import.meta.url));
const API_DIR = fileURLToPath(new URL(".", import.meta.url));

const readApiSource = (file: string) => readFileSync(join(API_DIR, file), "utf8");
const apiSources = readdirSync(API_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
// Which non-test files under server/api reference a literal code string.
const apiSourceOwners = (code: string) => apiSources.filter((f) => readApiSource(f).includes(code)).sort();

// ---------------------------------------------------------------------------
// The documented catalog (docs/API.md §Error Envelope). One row per code the
// section documents, with the status the doc pins. `null` = documented without
// a live REST status: the never-raised codes and the env-constant tokens the
// section names. The table is the floor: A6 requires every documented code to
// appear here, and the drift test below fails with the missing names.
// ---------------------------------------------------------------------------
type DocumentedCode = { code: string; status: number | null };
const DOCUMENTED: DocumentedCode[] = [
  // 400
  { code: "MCP_INVALID_TRANSPORT_CONFIG", status: 400 },
  { code: "SECRET_KEY_UNAVAILABLE", status: 400 },
  { code: "JEV_INVALID_CONFIG", status: 400 },
  { code: "GITHUB_MANIFEST_STATE_INVALID", status: 400 },
  // 401
  { code: "UNAUTHORIZED", status: 401 },
  { code: "GITHUB_WEBHOOK_ERROR", status: 401 },
  // 403
  { code: "FORBIDDEN", status: 403 },
  { code: "SETUP_LOCKED", status: 403 },
  { code: "SOLE_OWNER", status: 403 },
  { code: "CANNOT_DELETE_SELF", status: 403 },
  { code: "ATTACHMENT_DELETE_FORBIDDEN", status: 403 },
  { code: "CHAT_ATTACHMENTS_DISABLED", status: 403 },
  { code: "TASKS_BULK_DISABLED", status: 403 },
  // 404
  { code: "USER_NOT_FOUND", status: 404 },
  { code: "TEAM_NOT_FOUND", status: 404 },
  { code: "INVITE_NOT_FOUND", status: 404 },
  { code: "SESSION_NOT_FOUND", status: 404 },
  { code: "PROJECT_NOT_FOUND", status: 404 },
  { code: "COLUMN_NOT_FOUND", status: 404 },
  { code: "SWIMLANE_NOT_FOUND", status: 404 },
  { code: "MILESTONE_NOT_FOUND", status: 404 },
  { code: "TASK_NOT_FOUND", status: 404 },
  { code: "PAGE_NOT_FOUND", status: 404 },
  { code: "SOURCE_NOT_FOUND", status: 404 },
  { code: "ASSISTANT_TASK_NOT_FOUND", status: 404 },
  { code: "TASK_LINK_NOT_FOUND", status: 404 },
  { code: "API_KEY_NOT_FOUND", status: 404 },
  { code: "AGENT_NOT_FOUND", status: 404 },
  { code: "SKILL_NOT_FOUND", status: 404 },
  { code: "SHARE_LINK_NOT_FOUND", status: 404 },
  { code: "ATTACHMENT_NOT_FOUND", status: 404 },
  { code: "ASSISTANT_THREAD_NOT_FOUND", status: 404 },
  // 409
  { code: "SLUG_TAKEN", status: 409 },
  { code: "INVITE_PENDING", status: 409 },
  { code: "TASK_HAS_CHILDREN", status: 409 },
  { code: "TASK_LINK_CYCLE", status: 409 },
  { code: "HAS_CHILDREN", status: 409 },
  { code: "WIP_LIMIT", status: 409 },
  { code: "BACKLOG_PROTECTED", status: 409 },
  { code: "DEADLINE_AFTER_LANE", status: 409 },
  { code: "ALREADY_LINKED", status: 409 },
  { code: "OPTION_IN_USE", status: 409 },
  { code: "AGENT_ENTITY_IN_USE", status: 409 },
  { code: "TEAM_HAS_PROJECTS", status: 409 },
  { code: "CONSTRAINT", status: 409 },
  { code: "PROVIDER_NOT_CONFIGURED", status: 409 },
  { code: "ASSISTANT_TASK_ACTIVE", status: 409 },
  { code: "VISION_NOT_CONFIGURED", status: 409 },
  // 413
  { code: "BODY_TOO_LARGE", status: 413 },
  { code: "PAYLOAD_TOO_LARGE", status: 413 },
  // 422
  { code: "REQUIRED_FIELD", status: 422 },
  { code: "NEIGHBOR_NOT_IN_COLUMN", status: 422 },
  { code: "INVALID_OPTION", status: 422 },
  { code: "INVALID_TASK_LINK", status: 422 },
  { code: "AGENT_BUILTIN_DELETE", status: 422 },
  { code: "SEARCH_ERROR", status: 422 },
  { code: "INVALID_PARENT", status: 422 },
  { code: "SOURCE_UNREACHABLE", status: 422 },
  { code: "API_KEY_NAME_EMPTY", status: 422 },
  { code: "NOT_WORKSPACE_MEMBER", status: 422 },
  { code: "INVALID_ARGS", status: 422 },
  { code: "ATTACHMENT_EXTRACTION_FAILED", status: 422 },
  { code: "GITHUB_MANIFEST_PERMISSIONS_DENIED", status: 422 },
  // 429
  { code: "RATE_LIMITED", status: 429 },
  { code: "PROVIDER_RATE_LIMITED", status: 429 },
  // 500
  { code: "DATABASE_ERROR", status: 500 },
  { code: "INTERNAL", status: 500 },
  { code: "PASSWORD_LINK_FAILED", status: 500 },
  { code: "GITHUB_SECRET_WRITE_FAILED", status: 500 },
  // 502
  { code: "GITHUB_API_ERROR", status: 502 },
  { code: "SOURCE_FETCH_ERROR", status: 502 },
  { code: "PROVIDER_AUTH_FAILED", status: 502 },
  { code: "PROVIDER_UNREACHABLE", status: 502 },
  { code: "ASSISTANT_GENERATION_FAILED", status: 502 },
  { code: "ASSISTANT_TOOL_BUDGET_EXCEEDED", status: 502 },
  { code: "ASSISTANT_UNAVAILABLE", status: 502 },
  { code: "JEV_AUTH_FAILED", status: 502 },
  { code: "JEV_UNREACHABLE", status: 502 },
  { code: "GITHUB_MANIFEST_EXCHANGE_FAILED", status: 502 },
  // Reserved in the error map but never raised by a REST handler (see the doc).
  { code: "MISSING_AUTH", status: null },
  { code: "INVALID_API_KEY", status: null },
  { code: "LAST_ADMIN_DEMOTE", status: null },
  // Env-constant tokens the section names (not envelope codes).
  { code: "CHAT_ATTACHMENT_MAX_UPLOAD_BYTES", status: null },
  { code: "LXK_MAX_BODY_MB", status: null },
  { code: "LXK_MAX_UPLOAD_MB", status: null },
  { code: "LXK_SECRETS_MASTER_KEY", status: null },
];

// Codes the error map owns: the tag → documented status + envelope code.
type TaggedCode = { code: string; status: number; tag: string };
const TAG_MAP: TaggedCode[] = [
  { code: "MCP_INVALID_TRANSPORT_CONFIG", status: 400, tag: "McpInvalidTransportConfig" },
  { code: "SECRET_KEY_UNAVAILABLE", status: 400, tag: "SecretKeyUnavailable" },
  { code: "JEV_INVALID_CONFIG", status: 400, tag: "JevInvalidConfig" },
  { code: "GITHUB_MANIFEST_STATE_INVALID", status: 400, tag: "GithubManifestStateInvalid" },
  { code: "MISSING_AUTH", status: 401, tag: "MissingAuth" },
  { code: "INVALID_API_KEY", status: 401, tag: "InvalidKey" },
  { code: "FORBIDDEN", status: 403, tag: "Forbidden" },
  { code: "SETUP_LOCKED", status: 403, tag: "SetupLocked" },
  { code: "SOLE_OWNER", status: 403, tag: "SoleOwner" },
  { code: "CANNOT_DELETE_SELF", status: 403, tag: "CannotDeleteSelf" },
  { code: "ATTACHMENT_DELETE_FORBIDDEN", status: 403, tag: "AttachmentDeleteForbidden" },
  { code: "CHAT_ATTACHMENTS_DISABLED", status: 403, tag: "ChatAttachmentsDisabled" },
  { code: "TASKS_BULK_DISABLED", status: 403, tag: "TasksBulkDisabled" },
  { code: "USER_NOT_FOUND", status: 404, tag: "UserNotFound" },
  { code: "TEAM_NOT_FOUND", status: 404, tag: "TeamNotFound" },
  { code: "INVITE_NOT_FOUND", status: 404, tag: "InviteNotFound" },
  { code: "SESSION_NOT_FOUND", status: 404, tag: "SessionNotFound" },
  { code: "PROJECT_NOT_FOUND", status: 404, tag: "ProjectNotFound" },
  { code: "COLUMN_NOT_FOUND", status: 404, tag: "ColumnNotFound" },
  { code: "SWIMLANE_NOT_FOUND", status: 404, tag: "SwimlaneNotFound" },
  { code: "MILESTONE_NOT_FOUND", status: 404, tag: "MilestoneNotFound" },
  { code: "TASK_NOT_FOUND", status: 404, tag: "TaskNotFound" },
  { code: "PAGE_NOT_FOUND", status: 404, tag: "WikiPageNotFound" },
  { code: "SOURCE_NOT_FOUND", status: 404, tag: "SourceNotFound" },
  { code: "ASSISTANT_TASK_NOT_FOUND", status: 404, tag: "AssistantTaskNotFound" },
  { code: "TASK_LINK_NOT_FOUND", status: 404, tag: "TaskLinkNotFound" },
  { code: "API_KEY_NOT_FOUND", status: 404, tag: "ApiKeyNotFound" },
  { code: "AGENT_NOT_FOUND", status: 404, tag: "AgentNotFound" },
  { code: "SKILL_NOT_FOUND", status: 404, tag: "SkillNotFound" },
  { code: "SHARE_LINK_NOT_FOUND", status: 404, tag: "ShareLinkNotFound" },
  { code: "ATTACHMENT_NOT_FOUND", status: 404, tag: "AttachmentNotFound" },
  { code: "ASSISTANT_THREAD_NOT_FOUND", status: 404, tag: "AssistantThreadNotFound" },
  { code: "SLUG_TAKEN", status: 409, tag: "SlugTaken" },
  { code: "INVITE_PENDING", status: 409, tag: "InviteAlreadyPending" },
  { code: "TASK_HAS_CHILDREN", status: 409, tag: "TaskHasChildren" },
  { code: "TASK_LINK_CYCLE", status: 409, tag: "TaskLinkCycle" },
  { code: "HAS_CHILDREN", status: 409, tag: "HasChildren" },
  { code: "WIP_LIMIT", status: 409, tag: "WipLimitExceeded" },
  { code: "BACKLOG_PROTECTED", status: 409, tag: "BacklogProtected" },
  { code: "DEADLINE_AFTER_LANE", status: 409, tag: "DeadlineAfterLane" },
  { code: "ALREADY_LINKED", status: 409, tag: "GithubIssueAlreadyLinked" },
  { code: "OPTION_IN_USE", status: 409, tag: "OptionInUse" },
  { code: "AGENT_ENTITY_IN_USE", status: 409, tag: "AgentEntityInUse" },
  { code: "TEAM_HAS_PROJECTS", status: 409, tag: "TeamHasProjects" },
  { code: "CONSTRAINT", status: 409, tag: "ConstraintViolation" },
  { code: "PROVIDER_NOT_CONFIGURED", status: 409, tag: "ProviderNotConfigured" },
  { code: "ASSISTANT_TASK_ACTIVE", status: 409, tag: "AssistantTaskActive" },
  { code: "VISION_NOT_CONFIGURED", status: 409, tag: "VisionNotConfigured" },
  { code: "PAYLOAD_TOO_LARGE", status: 413, tag: "PayloadTooLarge" },
  { code: "REQUIRED_FIELD", status: 422, tag: "RequiredFieldMissing" },
  { code: "NEIGHBOR_NOT_IN_COLUMN", status: 422, tag: "NeighborNotInColumn" },
  { code: "INVALID_OPTION", status: 422, tag: "InvalidOption" },
  { code: "INVALID_TASK_LINK", status: 422, tag: "InvalidTaskLink" },
  { code: "AGENT_BUILTIN_DELETE", status: 422, tag: "AgentBuiltinDelete" },
  { code: "SEARCH_ERROR", status: 422, tag: "SearchError" },
  { code: "INVALID_PARENT", status: 422, tag: "InvalidParent" },
  { code: "SOURCE_UNREACHABLE", status: 422, tag: "SourceUnreachable" },
  { code: "API_KEY_NAME_EMPTY", status: 422, tag: "ApiKeyNameEmpty" },
  { code: "NOT_WORKSPACE_MEMBER", status: 422, tag: "MemberNotInWorkspace" },
  { code: "INVALID_ARGS", status: 422, tag: "InvalidArgs" },
  { code: "ATTACHMENT_EXTRACTION_FAILED", status: 422, tag: "AttachmentExtractionFailed" },
  { code: "GITHUB_MANIFEST_PERMISSIONS_DENIED", status: 422, tag: "GithubManifestPermissionsDenied" },
  { code: "DATABASE_ERROR", status: 500, tag: "DbError" },
  { code: "PASSWORD_LINK_FAILED", status: 500, tag: "PasswordLinkIssueFailed" },
  { code: "GITHUB_SECRET_WRITE_FAILED", status: 500, tag: "GithubSecretWriteFailed" },
  { code: "GITHUB_API_ERROR", status: 502, tag: "GithubApiError" },
  { code: "SOURCE_FETCH_ERROR", status: 502, tag: "SourceFetchError" },
  { code: "PROVIDER_AUTH_FAILED", status: 502, tag: "ProviderAuthFailed" },
  { code: "PROVIDER_UNREACHABLE", status: 502, tag: "ProviderUnreachable" },
  { code: "ASSISTANT_GENERATION_FAILED", status: 502, tag: "AssistantGenerationFailed" },
  { code: "ASSISTANT_TOOL_BUDGET_EXCEEDED", status: 502, tag: "AssistantToolBudgetExceeded" },
  { code: "ASSISTANT_UNAVAILABLE", status: 502, tag: "AssistantUnavailable" },
  { code: "JEV_AUTH_FAILED", status: 502, tag: "JevAuthFailed" },
  { code: "JEV_UNREACHABLE", status: 502, tag: "JevUnreachable" },
  { code: "GITHUB_MANIFEST_EXCHANGE_FAILED", status: 502, tag: "GithubManifestExchangeFailed" },
];

// Documented codes with no envelope-map tag (middleware / handler wrapper / doc only).
const UNMAPPED_CODES = ["UNAUTHORIZED", "BODY_TOO_LARGE", "RATE_LIMITED", "INTERNAL", "PROVIDER_RATE_LIMITED"];

// Documented as defined-in-the-map but never raised by any REST handler.

const documentedSection = () => readFileSync(API_MD, "utf8").split("## Error Envelope")[1]!.split("## Auth")[0]!;

let dir: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-error-catalog-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("error catalog matrix (docs/API.md §Error Envelope)", () => {
  it("covers exactly the codes documented in docs/API.md", () => {
    const documented = new Set([...documentedSection().matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]!));
    const table = new Set(DOCUMENTED.map((d) => d.code));
    expect([...documented].filter((c) => !table.has(c))).toEqual([]);
    expect([...table].filter((c) => !documented.has(c))).toEqual([]);
    expect(table.size).toBe(86);
  });

  it("maps every tag-backed documented code to its documented status and envelope code", () => {
    const failures: string[] = [];
    for (const { code, status, tag } of TAG_MAP) {
      const gotStatus = errorToStatus({ _tag: tag });
      const gotCode = errorResponse({ _tag: tag }).error.code;
      if (gotStatus !== status || gotCode !== code) {
        failures.push(`${code}: expected ${status}/${code}, got ${gotStatus}/${gotCode}`);
      }
    }
    expect(failures).toEqual([]);
    expect(TAG_MAP).toHaveLength(75);
  });

  it("emits the codes without an envelope-map tag with their documented status", () => {
    // The webhook, rate-limit, body-cap and defect-fallback responses are built
    // directly by the owning module (never routed through errorToStatus), so the
    // documented status is pinned at the emitter.
    const emitters: Array<[string, number, string]> = [
      ["middleware.ts", 401, "UNAUTHORIZED"],
      ["middleware.ts", 413, "BODY_TOO_LARGE"],
      ["middleware.ts", 429, "RATE_LIMITED"],
      ["http-helpers.ts", 500, "INTERNAL"],
      ["../entry.ts", 401, "GITHUB_WEBHOOK_ERROR"],
      ["../workers-entry.ts", 401, "GITHUB_WEBHOOK_ERROR"],
      ["../entry.ts", 413, "BODY_TOO_LARGE"],
      ["../entry.ts", 500, "INTERNAL"],
    ];
    const failures: string[] = [];
    for (const [file, status, code] of emitters) {
      const source = file.startsWith("..") ? readFileSync(join(API_DIR, file), "utf8") : readApiSource(file);
      if (!source.includes(`code: "${code}"`) || !new RegExp(`(status: ${status}|\\b${status}\\b)`).test(source)) {
        failures.push(`${file}: missing ${code} at ${status}`);
      }
    }
    expect(failures).toEqual([]);

    // PROVIDER_RATE_LIMITED is provider semantics carried on the assistant wire
    // with no envelope-map tag; it stays documented at 429.
    expect(documentedSection()).toContain("| 429 | `PROVIDER_RATE_LIMITED` |");
    for (const code of UNMAPPED_CODES) {
      expect(Object.values(errorCodeMap)).not.toContain(code);
    }
  });

  it("documents MISSING_AUTH / INVALID_API_KEY / LAST_ADMIN_DEMOTE / ASSISTANT_UNAVAILABLE as never raised", () => {
    // Reserved in the catalog where the doc says so, but no route source emits them.
    expect(apiSourceOwners("MISSING_AUTH")).toEqual(["errors.ts"]);
    expect(apiSourceOwners("INVALID_API_KEY")).toEqual(["errors.ts"]);
    expect(apiSourceOwners("LAST_ADMIN_DEMOTE")).toEqual([]);
    expect(apiSourceOwners("ASSISTANT_UNAVAILABLE")).toEqual(["errors.ts"]);
    expect(documentedSection()).toContain("Defined in the error map but never raised by any REST handler");
    // The three unmapped reserved tags carry no live status; ASSISTANT_UNAVAILABLE
    // keeps its 502 row for wire compat but is retired (no live path emits it).
    expect(DOCUMENTED.find((d) => d.code === "MISSING_AUTH")?.status).toBeNull();
    expect(DOCUMENTED.find((d) => d.code === "INVALID_API_KEY")?.status).toBeNull();
    expect(DOCUMENTED.find((d) => d.code === "LAST_ADMIN_DEMOTE")?.status).toBeNull();
    expect(documentedSection()).toContain("`ASSISTANT_UNAVAILABLE` | **Retired (ADR-0005 W6)**");
  });

  it("answers without credentials with 401 UNAUTHORIZED — never MISSING_AUTH / INVALID_API_KEY", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.code).not.toBe("MISSING_AUTH");
    expect(body.error.code).not.toBe("INVALID_API_KEY");
  });
});

describe("error message/details never leak (folded from errors.test.ts)", () => {
  it("returns generic text for DbError/ConstraintViolation — no raw SQLite", () => {
    expect(errorMessage(asCatalogError(new DbError({ message: "SQLiteError: no such table: secrets" })))).toBe("Database error");
    expect(errorMessage(asCatalogError(new ConstraintViolation({ message: RAW, isPositionConflict: true })))).toBe("Constraint violation");
    expect(errorMessage(asCatalogError(new DbError({ message: RAW })))).not.toContain("secrets");
  });

  it("strips raw SQLite text and keeps only isPositionConflict", () => {
    expect(errorDetails(asCatalogError(new DbError({ message: RAW, cause: new Error(RAW) })))).toEqual({});
    expect(errorDetails(asCatalogError(new ConstraintViolation({ message: RAW, isPositionConflict: true })))).toEqual({ isPositionConflict: true });
    expect(JSON.stringify(errorDetails(asCatalogError(new ConstraintViolation({ message: RAW, isPositionConflict: true })))).includes("tasks")).toBe(false);
  });

  it("response does not leak raw SQLite text", () => {
    const err = new ConstraintViolation({ message: RAW, isPositionConflict: true });
    const response = errorResponse(asCatalogError(err));
    expect(JSON.stringify(response)).not.toContain("UNIQUE constraint failed");
    expect(response.error.code).toBe("CONSTRAINT");
  });

  it("strips provider diagnostics (raw/rawEvent/upstreamBody/attempts) from client details", () => {
    const err = asCatalogError(
      new ProviderAuthFailed({
        message: "provider 401",
        status: 401,
        providerMessage: "bad key",
        raw: "RAW_UPSTREAM",
        rawEvent: "RAW_EVENT",
        upstreamBody: "UPSTREAM_BODY",
        retryAfter: 3,
        attempts: [{ model: "x" }],
        errorTag: "openai",
      })
    );
    expect(errorDetails(err)).toEqual({
      message: "provider 401",
      status: 401,
      providerMessage: "bad key",
      retryAfter: 3,
      errorTag: "openai",
    });
    const wire = JSON.stringify(errorResponse(err));
    expect(wire).not.toContain("RAW_UPSTREAM");
    expect(wire).not.toContain("RAW_EVENT");
    expect(wire).not.toContain("UPSTREAM_BODY");
    expect(wire).not.toContain("attempts");
  });

  it("applies the provider allowlist to every provider tag", () => {
    const cases = [
      new ProviderUnreachable({ message: "x", raw: "r", rawEvent: "e", upstreamBody: "b", attempts: [1] }),
      new AssistantGenerationFailed({ message: "x", raw: "r", rawEvent: "e", upstreamBody: "b", attempts: [1] }),
    ];
    for (const err of cases) {
      const details = errorDetails(asCatalogError(err));
      expect("raw" in details).toBe(false);
      expect("rawEvent" in details).toBe(false);
      expect("upstreamBody" in details).toBe(false);
      expect("attempts" in details).toBe(false);
      expect(details.message).toBe("x");
    }
  });
});
