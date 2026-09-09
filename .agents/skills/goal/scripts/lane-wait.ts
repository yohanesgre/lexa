#!/usr/bin/env bun
/**
 * lane-wait.ts — reactive wait for a herdr lane-pane sentinel.
 *
 *   bun .agents/skills/goal/scripts/lane-wait.ts <pane-id> <sentinel> [timeout-ms]
 *
 * Runs `herdr pane wait-output --match` (herdr-side blocking match, no
 * orchestrator sleep loop) with an Effect outer timeout. Exit 0 = sentinel
 * seen (+ elapsed printed), 1 = timeout/pane failure, 2 = bad argv.
 *
 * Pair with the runner-file vehicle from lane-dispatch.md: the lane brief
 * lives in a file executed via `herdr pane run <pane> "bash <runner>"`, so
 * the echoed command line never contains the sentinel and the match can
 * only fire on real completion.
 */
import { Data, Effect } from "effect";

export class InvalidArgs extends Data.TaggedError("InvalidArgs")<{ reason: string }> {}
export class PaneError extends Data.TaggedError("PaneError")<{ message: string }> {}
export class LaneTimeout extends Data.TaggedError("LaneTimeout")<{
  pane: string;
  sentinel: string;
  timeoutMs: number;
}> {}

interface Args {
  pane: string;
  sentinel: string;
  timeoutMs: number;
}

const decodeArgs = (argv: Array<string>): Effect.Effect<Args, InvalidArgs> => {
  const pane = argv[0];
  const sentinel = argv[1];
  if (pane === undefined || pane === "") {
    return Effect.fail(new InvalidArgs({ reason: "usage: lane-wait.ts <pane-id> <sentinel> [timeout-ms]" }));
  }
  if (sentinel === undefined || sentinel === "") {
    return Effect.fail(new InvalidArgs({ reason: "usage: lane-wait.ts <pane-id> <sentinel> [timeout-ms]" }));
  }
  const rawTimeout = argv[2] ?? "120000";
  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Effect.fail(new InvalidArgs({ reason: `timeout-ms must be a positive integer, got ${rawTimeout}` }));
  }
  return Effect.succeed({ pane, sentinel, timeoutMs });
};

interface HerdrResult {
  out: string;
  err: string;
  code: number;
}

const runHerdr = (args: Array<string>): Effect.Effect<HerdrResult, PaneError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
      if (proc.stdout === null || proc.stderr === null) {
        throw new Error("herdr stdio unavailable");
      }
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { out, err, code };
    },
    catch: (u) => new PaneError({ message: `herdr spawn failed: ${u instanceof Error ? u.message : String(u)}` }),
  });

const program = Effect.gen(function* () {
  const args = yield* decodeArgs(Bun.argv.slice(2));
  const started = Date.now();
  const res = yield* runHerdr([
    "pane",
    "wait-output",
    args.pane,
    "--match",
    args.sentinel,
    "--source",
    "recent-unwrapped",
    "--lines",
    "200",
    "--timeout",
    String(args.timeoutMs),
  ]).pipe(
    Effect.timeoutFail({
      duration: args.timeoutMs + 5000,
      onTimeout: () => new LaneTimeout({ pane: args.pane, sentinel: args.sentinel, timeoutMs: args.timeoutMs }),
    }),
  );
  if (res.code !== 0) {
    return yield* new PaneError({ message: res.err.trim() || res.out.trim() || `herdr exit ${res.code}` });
  }
  const elapsed = Date.now() - started;
  console.log(`lane-wait: sentinel seen in ${elapsed}ms`);
  console.log(res.out.slice(-2000));
});

Effect.runPromise(
  Effect.catchAll(program, (e: InvalidArgs | PaneError | LaneTimeout) =>
    Effect.sync(() => {
      const detail =
        e._tag === "InvalidArgs" ? e.reason : e._tag === "PaneError" ? e.message : `${e.pane} ${e.sentinel} ${e.timeoutMs}ms`;
      console.error(`lane-wait: ${e._tag}: ${detail}`);
      return e._tag === "InvalidArgs" ? 2 : 1;
    }),
  ),
).then(
  (code) => process.exit(code),
  (defect) => {
    console.error(`lane-wait: Defect: ${String(defect)}`);
    process.exit(1);
  },
);
