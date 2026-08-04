// React Doctor config (https://react.doctor/docs/configuration/config-files)
//
// `.repos/` is the vendored Effect source clone for the effect-ts skill
// (research only — pinned to the installed version, gitignored, never part of
// the build). Its findings are third-party code, not lexa; exclude it from
// scans so the CI gate and local runs only report on lexa code.
export default {
  ignore: {
    files: [".repos/**"],
  },
};
