import { env } from "./env.ts";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] > threshold) return;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](`[${level.toUpperCase()}]`, ...args);
}

export const logger = {
  error: (...args: unknown[]) => log("error", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  debug: (...args: unknown[]) => log("debug", ...args),
};