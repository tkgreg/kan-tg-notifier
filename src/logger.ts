import type { Logger as PinoLogger } from "pino";
import { pino } from "pino";

export type Logger = PinoLogger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "kan-tg-notifier" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
