// Runtime configuration from process.env, then .env.local (never committed). See .env.example.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function readEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith("#") && line.includes("="))
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

export interface Config {
  root: string;
  port: number;
  firmsKey: string;
  firmsSources: string[];
  firmsBbox: string;
  firmsDayRange: number;
  geminiKey: string;
  geminiModel: string;
  llmEnabled: boolean;
  llmTimeoutMs: number;
  llmMaxPerHour: number;
  llmMaxPerDay: number;
  llmDailyBudgetUsd: number;
  llmPriceInPerMTok: number;
  llmPriceOutPerMTok: number;
  webhookUrl: string;
  dispatchMaxAttempts: number;
  dispatchBackoffMs: number;
  dispatchSampleAlerts: boolean;
  dashboardUser: string;
  dashboardPassword: string;
  passwordGenerated: boolean;
  sessionSecret: string;
  sessionTtlHours: number;
  secureCookies: boolean;
  databaseUrl: string;
  pollWindowsUtc: string;
  pollInWindowMin: number;
  pollOutWindowMin: number;
  heartbeatMaxAgeMin: number;
  schedulerEnabled: boolean;
  runtimeDir: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const file = readEnvFile(join(ROOT, ".env.local"));
  const get = (k: string, d = "") => process.env[k] ?? file[k] ?? d;
  const num = (k: string, d: number) => {
    const v = Number(get(k, String(d)));
    return Number.isFinite(v) ? v : d;
  };
  const bool = (k: string, d: boolean) => {
    const v = get(k, d ? "true" : "false").toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  };
  const configuredPassword = get("DASHBOARD_PASSWORD");
  return {
    root: ROOT,
    port: num("PORT", 8787),
    firmsKey: get("FIRMS_MAP_KEY"),
    firmsSources: get("FIRMS_SOURCES", "VIIRS_SNPP_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT,MODIS_NRT")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    firmsBbox: get("FIRMS_BBOX", "68,6,98,36"), // India bounding box (west,south,east,north); configurable scope decision
    firmsDayRange: Math.min(10, Math.max(1, num("FIRMS_DAY_RANGE", 2))),
    geminiKey: get("GEMINI_API_KEY"),
    geminiModel: get("GEMINI_MODEL", "gemini-2.5-flash"),
    llmEnabled: bool("LLM_PHRASING_ENABLED", false),
    llmTimeoutMs: num("LLM_TIMEOUT_MS", 4000),
    llmMaxPerHour: num("LLM_MAX_CALLS_PER_HOUR", 30),
    llmMaxPerDay: num("LLM_MAX_CALLS_PER_DAY", 200),
    llmDailyBudgetUsd: num("LLM_DAILY_BUDGET_USD", 1),
    llmPriceInPerMTok: num("LLM_PRICE_INPUT_PER_MTOK", 0.3),
    llmPriceOutPerMTok: num("LLM_PRICE_OUTPUT_PER_MTOK", 2.5),
    webhookUrl: get("ALERT_WEBHOOK_URL"),
    dispatchMaxAttempts: num("DISPATCH_MAX_ATTEMPTS", 5),
    dispatchBackoffMs: num("DISPATCH_BACKOFF_MS", 2000),
    dispatchSampleAlerts: bool("DISPATCH_SAMPLE_ALERTS", false),
    dashboardUser: get("DASHBOARD_USER", "operator"),
    dashboardPassword: configuredPassword || randomBytes(9).toString("base64url"),
    passwordGenerated: !configuredPassword,
    sessionSecret: get("SESSION_SECRET") || randomBytes(32).toString("hex"),
    sessionTtlHours: num("SESSION_TTL_HOURS", 12),
    secureCookies: bool("SECURE_COOKIES", false),
    databaseUrl: get("DATABASE_URL"),
    // VIIRS/MODIS day and night passes over India plus NRT latency (UTC). Configurable.
    pollWindowsUtc: get("FIRMS_POLL_WINDOWS_UTC", "04:30-12:30,16:30-23:59"),
    pollInWindowMin: num("FIRMS_POLL_IN_WINDOW_MIN", 20),
    pollOutWindowMin: num("FIRMS_POLL_OUT_WINDOW_MIN", 180),
    heartbeatMaxAgeMin: num("HEARTBEAT_MAX_AGE_MIN", 240),
    schedulerEnabled: bool("SCHEDULER_ENABLED", true),
    runtimeDir: get("SATFIRE_RUNTIME_DIR", join(ROOT, "data", "runtime")),
    ...overrides,
  };
}
