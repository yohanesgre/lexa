// Base-only Workers API handler: every route group except the assistant tier,
// composed over D1 with the same middleware/auth/error semantics as the full
// handler. workers-entry.ts uses this for all non-assistant `/api/*` traffic so
// a board, wiki, or projects request never links or evaluates the assistant AI
// graph (`assistant-api.ts`). `createWorkersApiHandler` there stays the
// full-surface handler for assistant routes and existing tests.
import { HttpApiBuilder } from "@effect/platform";
import { Layer } from "effect";
import { LoggerLayer } from "../logging/logger";
import { Db, type DbDriver } from "../db/db";
import { RuntimeEnvLive, type RuntimeEnv } from "../runtime-env";
import { ApiAuthHooks, type ApiAuthHooksShape } from "./auth-hooks";
import {
  LexaBaseApi,
  baseRouteGroups,
  buildBaseServiceLayerWithStorage,
  createWorkersApiMiddleware,
} from "./http";
import { createMarkdownReadinessGate, isMarkdownReadinessExemptPath } from "./markdown-readiness";
import type { MiddlewareSession } from "./middleware";
import type { StorageConfigShape } from "../storage/config";

export interface CoreApiHandlerOptions {
  driver: DbDriver;
  runtimeEnv: RuntimeEnv;
  storage: StorageConfigShape;
  authHooks: ApiAuthHooksShape;
  getSession?: ((headers: Headers) => Promise<MiddlewareSession | null>) | undefined;
}

export function createCoreApiHandler(opts: CoreApiHandlerOptions) {
  const { driver, runtimeEnv, storage, authHooks } = opts;
  const dbLayer = Layer.mergeAll(
    Layer.succeed(Db, driver),
    RuntimeEnvLive(runtimeEnv),
    Layer.succeed(ApiAuthHooks, authHooks),
  );
  const serviceLayer = buildBaseServiceLayerWithStorage(storage);
  const handlerLayer = baseRouteGroups().pipe(
    Layer.provide(Layer.provide(serviceLayer, Layer.mergeAll(dbLayer, LoggerLayer))),
    Layer.provide(dbLayer)
  );
  const merged = Layer.mergeAll(HttpApiBuilder.api(LexaBaseApi), handlerLayer);
  const finalLayer = Layer.provide(
    merged,
    createWorkersApiMiddleware(driver, runtimeEnv, storage, { getSession: opts.getSession })
  );
  const { handler } = HttpApiBuilder.toWebHandler(finalLayer as never);
  const assertReady = createMarkdownReadinessGate(driver);
  return async (req: Request) => {
    if (!isMarkdownReadinessExemptPath(new URL(req.url).pathname)) {
      try {
        await assertReady();
      } catch {
        return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Internal error" } }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    return handler(req);
  };
}
