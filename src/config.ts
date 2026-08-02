import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const adminIdsFromString = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.coerce.number().int()));

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WEBHOOK_SECRET: z
    .string()
    .min(16, "WEBHOOK_SECRET must be at least 16 characters"),
  KAN_BASE_URL: z
    .string()
    .url("KAN_BASE_URL must be a valid URL")
    .transform((value) => value.replace(/\/+$/, "")),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ADMIN_TELEGRAM_IDS: adminIdsFromString.default(""),
  AUTO_APPROVE_LINKS: booleanFromString.default("false"),
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .default(600),
  EVENT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export interface AppConfig {
  telegramBotToken: string;
  databaseUrl: string;
  webhookSecret: string;
  kanBaseUrl: string;
  host: string;
  port: number;
  adminTelegramIds: readonly number[];
  autoApproveLinks: boolean;
  webhookTimestampToleranceSeconds: number;
  eventLogRetentionDays: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }

  return {
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    databaseUrl: parsed.data.DATABASE_URL,
    webhookSecret: parsed.data.WEBHOOK_SECRET,
    kanBaseUrl: parsed.data.KAN_BASE_URL,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    adminTelegramIds: parsed.data.ADMIN_TELEGRAM_IDS,
    autoApproveLinks: parsed.data.AUTO_APPROVE_LINKS,
    webhookTimestampToleranceSeconds:
      parsed.data.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    eventLogRetentionDays: parsed.data.EVENT_LOG_RETENTION_DAYS,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
