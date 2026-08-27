import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { cmdDeployWorkers, cmdUndeployWorkers } from "./deploy-workers";

describe("cmdDeployWorkers", () => {
  it("prints the D1 + R2 + KV + Worker route provisioning plan for staging", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await Effect.runPromise(
        cmdDeployWorkers({}, ["example.com", "staging"])
      );
      const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
      expect(out).toMatch(/Workers flavor: <lexa-preview\.example\.com>/);
      expect(out).toMatch(/D1 database name: lexa-staging/);
      expect(out).toMatch(/R2 bucket name:    lexa-blobs-staging/);
      expect(out).toMatch(/KV namespace for   staging/);
      expect(out).toMatch(/route: lexa-preview\.example\.com\/\*/);
    } finally {
      log.mockRestore();
    }
  });

  it("uses lexa.<domain> for prod flavor", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await Effect.runPromise(
        cmdDeployWorkers({}, ["example.com", "prod"])
      );
      const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
      expect(out).toMatch(/Workers flavor: <lexa\.example\.com>/);
      expect(out).toMatch(/D1 database name: lexa-prod/);
    } finally {
      log.mockRestore();
    }
  });

  it("exits with an error when no <domain> is given", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(Effect.runPromise(cmdDeployWorkers({}, []))).rejects.toThrow(/exit:1/);
    } finally {
      err.mockRestore();
      exit.mockRestore();
    }
  });
});

describe("cmdUndeployWorkers", () => {
  it("prints the teardown plan and notes data is preserved by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await Effect.runPromise(cmdUndeployWorkers({}, ["example.com"]));
      const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
      expect(out).toMatch(/Workers undeploy: <example\.com>/);
      expect(out).toMatch(/wrangler delete/);
      expect(out).toMatch(/data preserved/);
    } finally {
      log.mockRestore();
    }
  });

  it("notes --purge-data when the flag is set", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await Effect.runPromise(cmdUndeployWorkers({ "purge-data": true }, ["example.com"]));
      const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
      expect(out).toMatch(/--purge-data/);
      expect(out).toMatch(/irreversible/);
    } finally {
      log.mockRestore();
    }
  });
});
