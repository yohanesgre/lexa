import { Context, Effect, Layer } from "effect";
import { getEnv, type RuntimeEnv } from "./env";

export type { RuntimeEnv };

export class RuntimeEnvTag extends Context.Tag("Lexa/RuntimeEnv")<RuntimeEnvTag, RuntimeEnv>() {}

export const RuntimeEnvLive = (env: RuntimeEnv): Layer.Layer<RuntimeEnvTag> =>
  Layer.succeed(RuntimeEnvTag, env);

export const currentEnv: Effect.Effect<RuntimeEnv> = Effect.map(
  Effect.serviceOption(RuntimeEnvTag),
  (opt) => (opt._tag === "Some" ? opt.value : getEnv())
);

export function adminEmailsFrom(env: RuntimeEnv): string[] {
  return (env.LXK_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function staleMinFrom(env: RuntimeEnv): number {
  const v = Number(env.HEARTH_STALE_RUN_MIN);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

export function repoCapFrom(env: RuntimeEnv, fallback: number): number {
  const capParsed = Number.parseInt(env.LXK_HEARTH_REPO_CAP ?? "", 10);
  return Number.isFinite(capParsed) && capParsed > 0 ? capParsed : fallback;
}

export function storageEnvFrom(env: RuntimeEnv): Record<string, string | undefined> {
  return {
    LXK_STORAGE_DRIVER: env.LXK_STORAGE_DRIVER,
    LXK_STORAGE_FS_ROOT: env.LXK_STORAGE_FS_ROOT,
    LXK_S3_BUCKET: env.LXK_S3_BUCKET,
    LXK_S3_ACCESS_KEY_ID: env.LXK_S3_ACCESS_KEY_ID,
    LXK_S3_SECRET_ACCESS_KEY: env.LXK_S3_SECRET_ACCESS_KEY,
    LXK_S3_ENDPOINT: env.LXK_S3_ENDPOINT,
    LXK_S3_REGION: env.LXK_S3_REGION,
    LXK_MAX_UPLOAD_MB: env.LXK_MAX_UPLOAD_MB,
    LXK_MAX_BODY_MB: env.LXK_MAX_BODY_MB,
  };
}
