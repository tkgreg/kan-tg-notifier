import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./config.js";

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
    expect(config.autoApproveLinks).toBe(false);
    expect(config.webhookTimestampToleranceSeconds).toBe(600);
    expect(config.logLevel).toBe("info");
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
  });

  it("rejects a missing bot token", () => {
    const env: Record<string, string> = { ...validEnv };
    delete env.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("rejects a short webhook secret", () => {
    expect(() =>
      loadConfig({ ...validEnv, WEBHOOK_SECRET: "short" }),
    ).toThrow(ConfigError);
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

  it("rejects an invalid boolean flag", () => {
    expect(() =>
      loadConfig({ ...validEnv, AUTO_APPROVE_LINKS: "yes" }),
    ).toThrow(ConfigError);
  });
});
