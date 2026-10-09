import { BalanceError } from "./config.js";

const DAY = 86_400_000;
export interface Period { start: number; end: number; startDate: string; endDate: string }
export interface UsageParams { period?: "today" | "yesterday" | "month" | "last7days"; startDate?: string; endDate?: string }
const dateAt = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);
function midnight(date: string): number {
  const time = Date.parse(`${date}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || dateAt(time) !== date || date < "2000-01-01") {
    throw new BalanceError("ARGUMENTS", "日期请使用 YYYY-MM-DD 格式，例如 2026-10-01。");
  }
  return time;
}
export function resolvePeriod(params: UsageParams, now = Date.now()): Period | undefined {
  const today = dateAt(now);
  let { startDate, endDate } = params;
  if (params.period !== undefined) {
    if (startDate !== undefined || endDate !== undefined) throw new BalanceError("ARGUMENTS", "快捷时间与自定义日期不能同时使用。");
    switch (params.period) {
      case "today": startDate = endDate = today; break;
      case "yesterday": startDate = endDate = dateAt(midnight(today) - DAY); break;
      case "month": startDate = `${today.slice(0, 7)}-01`; endDate = today; break;
      case "last7days": startDate = dateAt(midnight(today) - 6 * DAY); endDate = today; break;
      default: throw new BalanceError("ARGUMENTS", "快捷时间支持今日、昨日、本月或近7天。");
    }
  }
  if (startDate === undefined && endDate === undefined) return undefined;
  if (typeof startDate !== "string" || (endDate !== undefined && typeof endDate !== "string")) {
    throw new BalanceError("ARGUMENTS", "请填写开始日期，可选填写结束日期。");
  }
  endDate ??= startDate;
  const start = midnight(startDate), end = midnight(endDate) + DAY;
  if (start >= end) throw new BalanceError("ARGUMENTS", "开始日期不能晚于结束日期。");
  if (endDate > today) throw new BalanceError("ARGUMENTS", "只能查询今天或之前的日期。");
  return { start, end: Math.min(end, now), startDate, endDate };
}
export const COMMAND_HELP = "用法：\n/balance — 查余额\n/balance usage — 最近10条\n/balance today — 今日消费\n/balance yesterday — 昨日消费\n/balance month — 本月消费\n/balance usage 2026-10-01 2026-10-08 — 按日期查询\n日期均按北京时间，包含起止日期。";
export function parseCommand(args: string, now = Date.now()): { mode: "balance" | "usage"; period?: Period } {
  if (!args.trim()) return { mode: "balance" };
  const parts = args.trim().split(/\s+/);
  if (parts[0] === "usage") parts.shift();
  if (!parts.length) return { mode: "usage" };
  const aliases: Record<string, UsageParams["period"]> = { today: "today", "今日": "today", "今天": "today", yesterday: "yesterday", "昨日": "yesterday", "昨天": "yesterday", month: "month", "本月": "month", last7days: "last7days", "近7天": "last7days" };
  if (parts.length === 1 && Object.hasOwn(aliases, parts[0]!)) return { mode: "usage", period: resolvePeriod({ period: aliases[parts[0]!] }, now) };
  if (parts.length <= 2 && /^\d{4}-/.test(parts[0]!)) return { mode: "usage", period: resolvePeriod({ startDate: parts[0], endDate: parts[1] }, now) };
  throw new BalanceError("ARGUMENTS", COMMAND_HELP);
}

export function formatTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ") : "时间未知";
}
