// Pure logic for the footer usage indicator (Claude Code / Codex); DOM lives in usage-bar.ts.
import { t } from "./i18n.ts";

export type UsageWindow = { pct: number; resetsAt: number | null };
export type ProductUsage = { fiveHour: UsageWindow | null; week: UsageWindow | null; plan: string | null; error: string | null; warning: string | null; updatedAt: number | null };
export type Level = "ok" | "warn" | "danger";

// 數字變色門檻：偏高黃、緊張紅。
export const WARN_AT = 70;
export const DANGER_AT = 90;

export function levelOf(pct: number): Level {
  return pct >= DANGER_AT ? "danger" : pct >= WARN_AT ? "warn" : "ok";
}

// Rust returns epoch seconds (Codex) or an ISO string (Claude); normalize to epoch ms.
function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function parseWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as { pct?: unknown; resets_at?: unknown };
  if (typeof entry.pct !== "number" || !Number.isFinite(entry.pct)) return null;
  return { pct: entry.pct, resetsAt: toMs(entry.resets_at) };
}

export function parseUsage(raw: unknown): ProductUsage {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fiveHour = parseWindow(r.five_hour);
  const week = parseWindow(r.week);
  const error = typeof r.error === "string" ? r.error : !fiveHour && !week ? "no-data" : null;
  return {
    fiveHour,
    week,
    plan: typeof r.plan === "string" ? r.plan : null,
    error,
    warning: typeof r.warning === "string" ? r.warning : null,
    updatedAt: typeof r.updated_at === "number" ? r.updated_at * 1000 : null,
  };
}

// A window whose reset time has passed is stale: the real value is back to 0.
export function effective(window: UsageWindow | null, now: number): { pct: number; expired: boolean } | null {
  if (!window) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return { pct: 0, expired: true };
  return { pct: window.pct, expired: false };
}

export type Mode = "used" | "left";

// 顯示用的數值：「剩餘」模式是 100 − 已用；變色等級永遠依已用量判斷。
export function displayPct(pct: number, mode: Mode): number {
  const used = Math.min(100, Math.max(0, pct));
  return mode === "left" ? 100 - used : used;
}

export function formatPct(pct: number): string {
  return `${Math.max(0, Math.round(pct))}%`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return t("usage.dur.dh", { d, h });
  if (h > 0) return t("usage.dur.hm", { h, m });
  return t("usage.dur.m", { m });
}

export function resetText(window: UsageWindow | null, now: number): string {
  if (!window || window.resetsAt === null) return "";
  if (window.resetsAt <= now) return t("usage.expired");
  return t("usage.resetsIn", { time: formatDuration(window.resetsAt - now) });
}

export function errorText(code: string): string {
  const key = `usage.err.${code}`;
  const text = t(key);
  return text === key ? t("usage.err.unknown") : text;
}

// 已有舊數字但這次更新失敗時的提示。
export function warningText(code: string): string {
  const key = `usage.warn.${code}`;
  const text = t(key);
  return text === key ? t("usage.warn.stale") : text;
}
