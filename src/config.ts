import { createHmac } from "node:crypto";
import { z } from "zod";

export const RUNTIME_MODES = ["persistent", "serverless"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/**
 * Path the Telegram update route is mounted on in serverless mode. The
 * route is authenticated by the secret token header, not by the path.
 */
export const TELEGRAM_WEBHOOK_PATH = "/telegram/updates";

/** Telegram's constraint on secret_token: 1-256 chars of A-Z, a-z, 0-9, _ and -. */
const TELEGRAM_SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Secret token Telegram echoes back in X-Telegram-Bot-Api-Secret-Token.
 * Derived from the bot token so it stays stable across restarts (and cold
 * starts) without extra configuration, while sharing no bytes with
 * WEBHOOK_SECRET: leaking one must not compromise the other.
 */
export function deriveTelegramWebhookSecret(botToken: string): string {
  return createHmac("sha256", botToken)
    .update("telegram-webhook")
    .digest("hex");
}

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

const stripTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, "");

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    WEBHOOK_SECRET: z
      .string()
      .min(16, "WEBHOOK_SECRET must be at least 16 characters"),
    KAN_BASE_URL: z
      .string()
      .url("KAN_BASE_URL must be a valid URL")
      .transform(stripTrailingSlashes),
    RUNTIME_MODE: z.enum(RUNTIME_MODES).default("persistent"),
    PUBLIC_URL: z
      .string()
      .url("PUBLIC_URL must be a valid URL")
      .transform(stripTrailingSlashes)
      .optional(),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(
        TELEGRAM_SECRET_TOKEN_PATTERN,
        "TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z, a-z, 0-9, _ or -",
      )
      .optional(),
    RUN_MIGRATIONS: booleanFromString.default("true"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    ADMIN_TELEGRAM_IDS: adminIdsFromString.default(""),
    AUTO_APPROVE_LINKS: booleanFromString.default("false"),
    GROUP_MEMBER_MENTIONS: booleanFromString.default("true"),
    WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .default(600),
    EVENT_AGGREGATION_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(300)
      .default(60),
    EVENT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.RUNTIME_MODE !== "serverless") return;

    if (env.PUBLIC_URL === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_URL"],
        message: "PUBLIC_URL is required when RUNTIME_MODE=serverless",
      });
      return;
    }
    if (!env.PUBLIC_URL.startsWith("https://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_URL"],
        message:
          "PUBLIC_URL must use https: Telegram only delivers webhooks over HTTPS",
      });
    }
  });

export interface AppConfig {
  telegramBotToken: string;
  databaseUrl: string;
  webhookSecret: string;
  kanBaseUrl: string;
  /**
   * persistent: long polling plus queued, post-response event processing.
   * serverless: Telegram webhook transport and events processed before the
   * HTTP response, so the platform may freeze the CPU or stop the instance
   * between requests.
   */
  runtimeMode: RuntimeMode;
  /** Public base URL of this service; always set in serverless mode. */
  publicUrl: string | undefined;
  /** Secret token expected on Telegram update deliveries. */
  telegramWebhookSecret: string;
  runMigrations: boolean;
  host: string;
  port: number;
  adminTelegramIds: readonly number[];
  autoApproveLinks: boolean;
  groupMemberMentions: boolean;
  webhookTimestampToleranceSeconds: number;
  /**
   * Quiet period per card before its collected events are rendered as
   * one combined message; every new event restarts the wait. 0 sends
   * every event separately. Only effective in persistent mode:
   * serverless instances may be frozen between requests and cannot hold
   * a timer.
   */
  eventAggregationSeconds: number;
  eventLogRetentionDays: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Treat blank values as absent. `FOO=` in a .env file or an empty Cloud Run
 * env var should fall back to the default instead of failing validation.
 */
function withoutBlankValues(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) => !(typeof value === "string" && value.trim() === ""),
    ),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(withoutBlankValues(env));

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
    runtimeMode: parsed.data.RUNTIME_MODE,
    publicUrl: parsed.data.PUBLIC_URL,
    telegramWebhookSecret:
      parsed.data.TELEGRAM_WEBHOOK_SECRET ??
      deriveTelegramWebhookSecret(parsed.data.TELEGRAM_BOT_TOKEN),
    runMigrations: parsed.data.RUN_MIGRATIONS,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    adminTelegramIds: parsed.data.ADMIN_TELEGRAM_IDS,
    autoApproveLinks: parsed.data.AUTO_APPROVE_LINKS,
    groupMemberMentions: parsed.data.GROUP_MEMBER_MENTIONS,
    webhookTimestampToleranceSeconds:
      parsed.data.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    eventAggregationSeconds: parsed.data.EVENT_AGGREGATION_SECONDS,
    eventLogRetentionDays: parsed.data.EVENT_LOG_RETENTION_DAYS,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
