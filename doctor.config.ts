// React Doctor config (https://react.doctor/docs/configuration/config-files)
//
// `.repos/` is the vendored Effect source clone for the effect-ts skill
// (research only — pinned to the installed version, gitignored, never part of
// the build). Its findings are third-party code, not lexa; exclude it from
// scans so the CI gate and local runs only report on lexa code.
//
// `app/router.tsx` is flagged "unused-file" but it is NOT dead: it's the
// TanStack Start router entry wired in app.config.ts (the build fails without
// it — `Could not resolve entry for router entry`). No code imports it, which
// is exactly what the detector matches; the reference lives in build config,
// not imports. Documented false positive.
export default {
  ignore: {
    files: [".repos/**", "app/router.tsx"],
  },
};
