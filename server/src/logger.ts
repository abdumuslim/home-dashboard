import pino from "pino";

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || "info",
});

export interface AppLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function childLogger(name: string): AppLogger {
  const child = pinoLogger.child({ component: name });

  function log(level: "info" | "warn" | "error" | "debug", args: unknown[]) {
    if (args.length === 0) return;
    if (args.length === 1) {
      child[level](typeof args[0] === "string" ? args[0] : (args[0] as object));
      return;
    }
    // Two args: msg + error/data — use pino's mergingObject syntax
    const [first, second] = args;
    if (typeof first === "string") {
      if (second instanceof Error) {
        child[level]({ err: second }, first);
      } else if (typeof second === "object" && second !== null) {
        child[level](second as object, first);
      } else {
        // Concatenate non-object values into message
        child[level](args.map(String).join(" "));
      }
    } else {
      child[level](args.map(String).join(" "));
    }
  }

  return {
    info: (...args: unknown[]) => log("info", args),
    warn: (...args: unknown[]) => log("warn", args),
    error: (...args: unknown[]) => log("error", args),
    debug: (...args: unknown[]) => log("debug", args),
  };
}
