import { Logger, LogLevel, Layer } from "effect";

const levelFromEnv = (): LogLevel.LogLevel => {
  const raw = (typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined) ?? "info";
  switch (raw.toLowerCase()) {
    case "trace": return LogLevel.Trace;
    case "debug": return LogLevel.Debug;
    case "info":  return LogLevel.Info;
    case "warn":
    case "warning": return LogLevel.Warning;
    case "error": return LogLevel.Error;
    case "fatal": return LogLevel.Fatal;
    case "none": return LogLevel.None;
    default:      return LogLevel.Info;
  }
};

const logLevel = levelFromEnv();

const structuredLogger = Logger.make(({ logLevel, message, annotations, date, fiberId }) => {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(annotations)) {
    if (key.startsWith("_")) continue;
    extra[key] = value;
  }
  const entry = {
    level: logLevel.label,
    message: String(message),
    timestamp: date.toISOString(),
    fiber: fiberId.id,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (logLevel.label === "ERROR" || logLevel.label === "FATAL") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
});

export const LoggerLayer = Layer.provideMerge(
  Logger.replace(Logger.defaultLogger, structuredLogger),
  Logger.minimumLogLevel(logLevel),
);

export { logLevel };
