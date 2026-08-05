import { describe, it, expect } from "vitest";
import { DbError, ConstraintViolation } from "../db/database";
import { TaskNotFound, errorToStatus, errorMessage, errorDetails, errorResponse } from "./errors";

const RAW = "UNIQUE constraint failed: tasks.column_id, tasks.position";

// errorMessage/errorDetails/errorResponse take `{ _tag } & Record<string, unknown>`;
// Data.TaggedError instances have no index signature, so cast at the call site.
const asCatalogError = (e: object) => e as unknown as { _tag: string } & Record<string, unknown>;

describe("errorToStatus", () => {
  it("maps ConstraintViolation to 409", () => {
    expect(errorToStatus(new ConstraintViolation({ message: RAW, isPositionConflict: true }))).toBe(409);
  });

  it("maps DbError to 500", () => {
    expect(errorToStatus(new DbError({ message: "SQLiteError: no such table: x" }))).toBe(500);
  });

  it("keeps existing domain mapping (TaskNotFound → 404)", () => {
    expect(errorToStatus(new TaskNotFound({ id: "t1" }))).toBe(404);
  });
});

describe("errorMessage scrubbing", () => {
  it("returns generic text for DbError — no raw SQLite message", () => {
    const msg = errorMessage(asCatalogError(new DbError({ message: "SQLiteError: no such table: secrets" })));
    expect(msg).toBe("Database error");
    expect(msg).not.toContain("no such table");
    expect(msg).not.toContain("secrets");
  });

  it("returns generic text for ConstraintViolation — no raw SQLite message", () => {
    const msg = errorMessage(asCatalogError(new ConstraintViolation({ message: RAW, isPositionConflict: true })));
    expect(msg).toBe("Constraint violation");
    expect(msg).not.toContain("UNIQUE");
    expect(msg).not.toContain("tasks");
    expect(msg).not.toContain("column_id");
  });
});

describe("errorDetails scrubbing", () => {
  it("strips raw SQLite text and cause from DbError details", () => {
    const details = errorDetails(asCatalogError(new DbError({ message: RAW, cause: new Error(RAW) })));
    expect(details).toEqual({});
    expect(JSON.stringify(details)).not.toContain("tasks");
  });

  it("keeps only isPositionConflict for ConstraintViolation — no table/column names", () => {
    const details = errorDetails(asCatalogError(new ConstraintViolation({ message: RAW, isPositionConflict: true })));
    expect(details).toEqual({ isPositionConflict: true });
    const json = JSON.stringify(details);
    expect(json).not.toContain("tasks");
    expect(json).not.toContain("position");
  });

  it("keeps raw message only inside the error object itself, not in the response", () => {
    const err = new ConstraintViolation({ message: RAW, isPositionConflict: true });
    expect(err.message).toBe(RAW); // server-side detail preserved
    const response = errorResponse(asCatalogError(err));
    expect(JSON.stringify(response)).not.toContain("UNIQUE constraint failed");
    expect(response.error).toEqual({ code: "CONSTRAINT", message: "Constraint violation", details: { isPositionConflict: true } });
  });

  it("DbError response carries the DATABASE_ERROR code and no raw text", () => {
    const response = errorResponse(asCatalogError(new DbError({ message: "SQLiteError: database is locked" })));
    expect(response.error.code).toBe("DATABASE_ERROR");
    expect(JSON.stringify(response)).not.toContain("locked");
  });
});
