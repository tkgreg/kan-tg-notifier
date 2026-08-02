import { pino } from "pino";

import type { Logger } from "../logger.js";

export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}
