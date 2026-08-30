import { describe, it, expect } from "vitest";
import { DbError, ConstraintViolation } from "../db/database";
import { TaskNotFound, TaskHasChildren, MilestoneNotFound, InvalidArgs, VisionNotConfigured, EngineNotSupportedForChat, errorToStatus, errorResponse, errorMessage, errorDetails } from "./errors";
import { CommentNotFound, CommentInvalid } from "./errors";

const RAW = "UNIQUE constraint failed: tasks.column_id, tasks.position";

const asCatalogError = (e: object) => e as unknown as { _tag: string } & Record<string, unknown>;

describe("errorToStatus", () => {
  it("maps ConstraintViolation to 409 and DbError to 500", () => {
    expect(errorToStatus(new ConstraintViolation({ message: RAW, isPositionConflict: true }))).toBe(409);
    expect(errorToStatus(new DbError({ message: "SQLiteError: no such table: x" }))).toBe(500);
  });

  it("maps TaskNotFound → 404 and TaskHasChildren → 409", () => {
    expect(errorToStatus(new TaskNotFound({ id: "t1" }))).toBe(404);
    expect(errorToStatus(new TaskHasChildren({ taskId: "t1" }))).toBe(409);
    expect(errorResponse(asCatalogError(new TaskHasChildren({ taskId: "t1" }))).error.code).toBe("TASK_HAS_CHILDREN");
  });

  it("maps comment errors to their statuses and codes", () => {
    expect(errorToStatus(new CommentNotFound({ id: 1 }))).toBe(404);
    expect(errorToStatus(new CommentInvalid({ reason: "comment body is empty" }))).toBe(422);
    expect(errorResponse(asCatalogError(new CommentInvalid({ reason: "comment body is empty" }))).error.code).toBe("COMMENT_INVALID");
  });

  it("maps MilestoneNotFound → 404 and InvalidArgs → 422", () => {
    expect(errorToStatus(new MilestoneNotFound({ id: "ms1" }))).toBe(404);
    expect(errorToStatus(new InvalidArgs({ reason: "startAt cannot be later than dueAt" }))).toBe(422);
  });

  it("maps VisionNotConfigured and EngineNotSupportedForChat → 409", () => {
    expect(errorToStatus(new VisionNotConfigured())).toBe(409);
    expect(errorToStatus(new EngineNotSupportedForChat({ engine: "blacksmith" }))).toBe(409);
  });
});

describe("errorMessage scrubbing", () => {
  it("returns generic text for DbError/ConstraintViolation — no raw SQLite", () => {
    expect(errorMessage(asCatalogError(new DbError({ message: "SQLiteError: no such table: secrets" })))).toBe("Database error");
    expect(errorMessage(asCatalogError(new ConstraintViolation({ message: RAW, isPositionConflict: true })))).toBe("Constraint violation");
    expect(errorMessage(asCatalogError(new DbError({ message: RAW })))).not.toContain("secrets");
  });
});

describe("errorDetails scrubbing", () => {
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
});
