import { describe, expect, it } from "vitest";

import {
  ConfigError,
  deriveTelegramWebhookSecret,
  loadConfig,
} from "./config.js";

const validEnv = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  DATABASE_URL: "postgres://localhost:5432/test",
  WEBHOOK_SECRET: "a-secret-with-16plus-chars",
  KAN_BASE_URL: "https://kan.example.com",
};

describe("loadConfig", () => {
  it("loads a valid configuration with defaults", () => {
    const config = loadConfig({ ...validEnv });
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.adminTelegramIds).toEqual([]);
    expect(config.pulseTelegramChatIds).toEqual([]);
    expect(config.autoApproveLinks).toBe(false);
    expect(config.groupMemberMentions).toBe(true);
    expect(config.webhookTimestampToleranceSeconds).toBe(600);
    expect(config.eventAggregationSeconds).toBe(60);
    expect(config.eventLogRetentionDays).toBe(30);
    expect(config.logLevel).toBe("info");
    expect(config.runtimeMode).toBe("persistent");
    expect(config.publicUrl).toBeUndefined();
    expect(config.runMigrations).toBe(true);
  });

  it("treats blank values as absent so defaults apply", () => {
    const config = loadConfig({
      ...validEnv,
      HOST: "",
      PUBLIC_URL: "   ",
      ADMIN_TELEGRAM_IDS: "",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.publicUrl).toBeUndefined();
    expect(config.adminTelegramIds).toEqual([]);
  });

  it("parses EVENT_AGGREGATION_SECONDS and rejects negative values", () => {
    expect(
      loadConfig({ ...validEnv, EVENT_AGGREGATION_SECONDS: "0" })
        .eventAggregationSeconds,
    ).toBe(0);
    expect(() =>
      loadConfig({ ...validEnv, EVENT_AGGREGATION_SECONDS: "-1" }),
    ).toThrow(ConfigError);
  });

  it("parses RUN_MIGRATIONS", () => {
    expect(
      loadConfig({ ...validEnv, RUN_MIGRATIONS: "false" }).runMigrations,
    ).toBe(false);
  });

  it("strips trailing slashes from KAN_BASE_URL", () => {
    const config = loadConfig({
      ...validEnv,
      KAN_BASE_URL: "https://kan.example.com/",
    });
    expect(config.kanBaseUrl).toBe("https://kan.example.com");
  });

  it("parses the admin id list", () => {
    const config = loadConfig({
      ...validEnv,
      ADMIN_TELEGRAM_IDS: "111, 222 ,333",
    });
    expect(config.adminTelegramIds).toEqual([111, 222, 333]);
  });

  it("parses boolean flags", () => {
    expect(
      loadConfig({ ...validEnv, AUTO_APPROVE_LINKS: "true" }).autoApproveLinks,
    ).toBe(true);
    expect(
      loadConfig({ ...validEnv, GROUP_MEMBER_MENTIONS: "false" })
        .groupMemberMentions,
    ).toBe(false);
  });

  it("rejects a missing bot token", () => {
    const env: Record<string, string> = { ...validEnv };
    delete env.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("rejects a short webhook secret", () => {
    expect(() => loadConfig({ ...validEnv, WEBHOOK_SECRET: "short" })).toThrow(
      ConfigError,
    );
  });

  it("rejects an invalid KAN_BASE_URL", () => {
    expect(() =>
      loadConfig({ ...validEnv, KAN_BASE_URL: "not a url" }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-numeric admin id", () => {
    expect(() =>
      loadConfig({ ...validEnv, ADMIN_TELEGRAM_IDS: "111,abc" }),
    ).toThrow(ConfigError);
  });

  it("requires an explicit negative group allowlist and webhook runtime for Pulse", () => {
    const enabled = {
      ...validEnv,
      RUNTIME_MODE: "serverless",
      PUBLIC_URL: "https://bot.example.com",
    };
    expect(
      loadConfig({
        ...enabled,
        PULSE_TELEGRAM_CHAT_IDS: "-100123, -100123, -123",
      }).pulseTelegramChatIds,
    ).toEqual([-100123, -123]);
    for (const ids of ["123", "all", "-9007199254740993", "-1e3"]) {
      expect(() =>
        loadConfig({ ...enabled, PULSE_TELEGRAM_CHAT_IDS: ids }),
      ).toThrow(ConfigError);
    }
    expect(() =>
      loadConfig({ ...validEnv, PULSE_TELEGRAM_CHAT_IDS: "-100123" }),
    ).toThrow(ConfigError);
  });

  it("rejects an invalid boolean flag", () => {
    expect(() =>
      loadConfig({ ...validEnv, AUTO_APPROVE_LINKS: "yes" }),
    ).toThrow(ConfigError);
  });

  describe("serverless mode", () => {
    const serverlessEnv = {
      ...validEnv,
      RUNTIME_MODE: "serverless",
      PUBLIC_URL: "https://bot.example.com",
    };

    it("loads with a public URL", () => {
      const config = loadConfig(serverlessEnv);
      expect(config.runtimeMode).toBe("serverless");
      expect(config.publicUrl).toBe("https://bot.example.com");
    });

    it("strips trailing slashes from PUBLIC_URL", () => {
      const config = loadConfig({
        ...serverlessEnv,
        PUBLIC_URL: "https://bot.example.com/",
      });
      expect(config.publicUrl).toBe("https://bot.example.com");
    });

    it("rejects a missing PUBLIC_URL", () => {
      expect(() =>
        loadConfig({ ...validEnv, RUNTIME_MODE: "serverless" }),
      ).toThrow(/PUBLIC_URL is required/);
    });

    it("rejects a plain http PUBLIC_URL", () => {
      expect(() =>
        loadConfig({ ...serverlessEnv, PUBLIC_URL: "http://bot.example.com" }),
      ).toThrow(/https/);
    });

    it("rejects an unknown runtime mode", () => {
      expect(() => loadConfig({ ...validEnv, RUNTIME_MODE: "lambda" })).toThrow(
        ConfigError,
      );
    });
  });

  describe("Telegram webhook secret", () => {
    it("derives a stable secret that differs from WEBHOOK_SECRET", () => {
      const first = loadConfig({ ...validEnv }).telegramWebhookSecret;
      const second = loadConfig({ ...validEnv }).telegramWebhookSecret;

      expect(first).toBe(second);
      expect(first).toBe(
        deriveTelegramWebhookSecret(validEnv.TELEGRAM_BOT_TOKEN),
      );
      expect(first).not.toBe(validEnv.WEBHOOK_SECRET);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it("derives a different secret for a different bot token", () => {
      expect(deriveTelegramWebhookSecret("123:abc")).not.toBe(
        deriveTelegramWebhookSecret("456:def"),
      );
    });

    it("prefers an explicitly configured secret", () => {
      const config = loadConfig({
        ...validEnv,
        TELEGRAM_WEBHOOK_SECRET: "explicit-secret-token_1",
      });
      expect(config.telegramWebhookSecret).toBe("explicit-secret-token_1");
    });

    it("rejects a secret with characters Telegram does not allow", () => {
      expect(() =>
        loadConfig({
          ...validEnv,
          TELEGRAM_WEBHOOK_SECRET: "secret with spaces!",
        }),
      ).toThrow(ConfigError);
    });

    it("rejects a too short secret", () => {
      expect(() =>
        loadConfig({ ...validEnv, TELEGRAM_WEBHOOK_SECRET: "short" }),
      ).toThrow(ConfigError);
    });
  });
});
