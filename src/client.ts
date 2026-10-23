import { createHash } from "node:crypto";
import { apiRoot, BalanceError, publicError, safeText, type PluginConfig } from "./config.js";
import { formatTime, type Period } from "./period.js";

type Json = Record<string, unknown>;
type Issue = ReturnType<typeof publicError> & { section: string };
export interface Credential { provider: string; baseUrl: string; apiKey: string; accountBilling: boolean }
export interface Display { unit: "CNY" | "USD" | "积分"; quotaPerUnit: number; rate: number }
export interface Snapshot {
  provider: string;
  keyFingerprint: string;
  queriedAt: string;
  cached: boolean;
  stale: boolean;
  display?: Display;
  account?: { available: number; used: number; approximate: true };
  token?: { name: string; usedQuota: number; availableQuota?: number; unlimited: boolean; expiresAt: number };
  recent?: { time: string; type: number; model: string; quota: number; inputTokens: number; outputTokens: number }[];
  period?: Period & { spentQuota: number; refundQuota: number; count: number; refundCount: number; limited: boolean };
  issues: Issue[];
}
const record = (v: unknown): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BalanceError("BAD_RESPONSE", "平台返回的数据格式不完整。");
  return v as Json;
};
const number = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BalanceError("BAD_RESPONSE", "平台返回的数值无效。");
  return v;
};
const timestamp = (v: unknown): string => {
  const n = number(v);
  if (n < 0 || n > 8.64e12) throw new BalanceError("BAD_RESPONSE", "平台返回的时间无效。");
  return new Date(n * 1000).toISOString();
};
export function fingerprint(key: string): string { return createHash("sha256").update(key).digest("hex").slice(0, 12); }
export function convertQuota(quota: number, display: Display): number {
  return display.unit === "积分" ? quota : quota / display.quotaPerUnit * display.rate;
}

export class NewApiClient {
  private cache = new Map<string, { at: number; value: Snapshot }>();
  private pending = new Map<string, Promise<Snapshot>>();
  private retry = new Map<string, number>();
  constructor(private options: Pick<PluginConfig, "cacheSeconds" | "timeoutMs">,
    private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}

  async query(credential: Credential, mode: "balance" | "usage", signal?: AbortSignal, period?: Period): Promise<Snapshot> {
    signal?.throwIfAborted();
    const root = apiRoot(credential.baseUrl);
    // Full digest for isolation; credentials and fingerprints are never displayed.
    const digest = createHash("sha256").update(credential.apiKey).digest("hex");
    const key = `${root}|${credential.provider}|${digest}|${credential.accountBilling}|${mode}|${period ? `${period.startDate}:${period.endDate}` : ""}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.options.cacheSeconds * 1000) {
      return structuredClone({ ...hit.value, cached: true });
    }
    const retryAt = this.retry.get(root) ?? 0;
    if (retryAt > this.now()) {
      const error = new BalanceError("RATE_LIMITED", "平台查询限流，请在指定时间后重试。", retryAt);
      if (hit && this.now() - hit.at < 300_000) return structuredClone({ ...hit.value, cached: true, stale: true,
        issues: [...hit.value.issues, { section: "refresh", ...publicError(error) }] });
      throw error;
    }
    const existing = this.pending.get(key);
    if (existing) return structuredClone(await existing);
    // Do not tie shared work to one caller's cancellation; each caller rechecks before disclosure.
    const work = this.load(credential, root, mode, period).then(result => {
      const fatalAuth = result.issues.some(i => i.code === "AUTH" || i.code === "FORBIDDEN");
      if (!fatalAuth && (result.account || result.token || result.recent || result.period)) {
        this.cache.set(key, { at: this.now(), value: result });
        if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      } else this.cache.delete(key);
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    const result = await work;
    signal?.throwIfAborted();
    return structuredClone(result);
  }

  private async get(root: string, path: string, apiKey?: string): Promise<unknown> {
    const retryAt = this.retry.get(root) ?? 0;
    if (retryAt > this.now()) throw new BalanceError("RATE_LIMITED", "平台查询限流，请稍后重试。", retryAt);
    let res: Response;
    try {
      res = await this.fetcher(new URL(path, root), { method: "GET", redirect: "error",
        headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch { throw new BalanceError("NETWORK", "连接平台失败或超时，请稍后重试。"); }
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
      const date = header ? Date.parse(header) : NaN;
      const at = seconds !== undefined ? this.now() + seconds * 1000 : Number.isFinite(date) ? date : this.now() + 60_000;
      this.retry.set(root, Math.max(this.now() + 1000, at));
      await res.body?.cancel();
      throw new BalanceError("RATE_LIMITED", "平台查询限流，请在指定时间后重试。", this.retry.get(root));
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) throw new BalanceError("AUTH", "该接口拒绝当前 Key；可能已过期、额度耗尽或失效，请检查平台状态。");
      if (res.status === 403) throw new BalanceError("FORBIDDEN", "平台拒绝查询，请检查账号状态或 Key 的访问限制。");
      throw new BalanceError("HTTP", `平台查询失败（HTTP ${res.status}）。`);
    }
    try {
      // Bound response size without ever reflecting raw response/error text to the user.
      const reader = res.body?.getReader();
      if (!reader) throw new Error();
      let size = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      const data = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (data.error || data.success === false || data.code === false) throw new Error();
      return data;
    } catch { throw new BalanceError("BAD_RESPONSE", "平台返回错误或无效数据，未将其解释为余额为零。"); }
  }

  private async load(c: Credential, root: string, mode: "balance" | "usage", period?: Period): Promise<Snapshot> {
    const result: Snapshot = { provider: safeText(c.provider), keyFingerprint: fingerprint(c.apiKey),
      queriedAt: new Date(this.now()).toISOString(), cached: false, stale: false, issues: [] };
    const attempt = async (section: string, action: () => Promise<void>) => {
      try { await action(); } catch (error) { result.issues.push({ section, ...publicError(error) }); }
    };
    await attempt("display", async () => {
      const status = record(record(await this.get(root, "api/status")).data);
      const type = status.quota_display_type;
      if (!["CNY", "USD", "TOKENS"].includes(String(type))) throw new BalanceError("CONFIG", "无法确认平台额度显示单位，暂不换算金额。");
      const quotaPerUnit = number(status.quota_per_unit);
      const rate = type === "CNY" ? number(status.usd_exchange_rate) : 1;
      if (quotaPerUnit <= 0 || rate <= 0) throw new BalanceError("BAD_RESPONSE", "平台额度换算配置无效。");
      result.display = { unit: type === "TOKENS" ? "积分" : type as "CNY" | "USD", quotaPerUnit, rate };
    });
    if (mode === "balance") {
      await attempt("token", async () => {
        const token = record(record(await this.get(root, "api/usage/token/", c.apiKey)).data);
        if (typeof token.unlimited_quota !== "boolean") throw new BalanceError("BAD_RESPONSE", "Key 额度类型无效。");
        result.token = { name: safeText(token.name), usedQuota: number(token.total_used),
          unlimited: token.unlimited_quota, expiresAt: number(token.expires_at),
          ...(!token.unlimited_quota ? { availableQuota: number(token.total_available) } : {}) };
      });
      if (c.accountBilling && result.display) await attempt("account", async () => {
        const subscription = record(await this.get(root, "v1/dashboard/billing/subscription", c.apiKey));
        const usage = record(await this.get(root, "v1/dashboard/billing/usage", c.apiKey));
        const used = number(usage.total_usage) / 100;
        result.account = { available: number(subscription.hard_limit_usd) - used, used, approximate: true };
      });
      else if (!c.accountBilling) result.issues.push({ section: "account", code: "SCOPE_UNCONFIRMED",
        message: "当前平台暂未开通账户余额查询，请联系管理员；当前 Key 用量仍可查询。" });
    } else {
      await attempt("recent", async () => {
        const logs = record(await this.get(root, "api/log/token", c.apiKey)).data;
        if (!Array.isArray(logs)) throw new BalanceError("BAD_RESPONSE", "近期记录格式无效。");
        if (period) {
          let spentQuota = 0, refundQuota = 0, count = 0, refundCount = 0;
          for (const log of logs.map(record)) {
            const time = Date.parse(timestamp(log.created_at));
            if (time < period.start || time >= period.end || (log.type !== 2 && log.type !== 6)) continue;
            const quota = number(log.quota);
            // rc.41 records refunds as positive quota. Do not guess other sign conventions.
            if (log.type === 6) {
              if (quota < 0) throw new BalanceError("BAD_RESPONSE", "退款记录口径异常，暂不汇总该时段金额。");
              refundQuota += quota; refundCount++;
            } else { spentQuota += quota; count++; }
          }
          result.period = { ...period, spentQuota, refundQuota, count, refundCount, limited: logs.length >= 1000 };
          return;
        }
        result.recent = logs.map(record).filter(log => log.type === 2 || log.type === 6)
          .sort((a, b) => number(b.created_at) - number(a.created_at)).slice(0, 10)
          .map(log => ({ time: timestamp(log.created_at), type: number(log.type), model: safeText(log.model_name),
            quota: number(log.quota), inputTokens: number(log.prompt_tokens ?? 0), outputTokens: number(log.completion_tokens ?? 0) }));
      });
    }
    return result;
  }
}

export function formatSnapshot(s: Snapshot): string {
  const lines = [s.period ? "时段消费" : s.recent ? "最近消费" : "账户余额"];
  const amount = (n: number) => {
    const value = (Math.abs(n) < 0.005 ? 0 : n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return s.display?.unit === "CNY" ? `¥${value}` : s.display?.unit === "USD" ? `$${value} USD` : `${value} 积分`;
  };
  const quota = (n: number) => s.display ? amount(convertQuota(n, s.display)) : "暂无法换算";
  if (s.account) {
    lines.push(`可用余额：${amount(s.account.available)}`, `账户累计消费：${amount(s.account.used)}`);
  } else if (s.token) lines.push("可用余额：暂无法查询");
  if (s.token) {
    // Omit duplicate cumulative spending, but retain scope when the key differs from the wallet.
    if (!s.account || !s.display || Math.abs(convertQuota(s.token.usedQuota, s.display) - s.account.used) >= 0.005) {
      lines.push(`当前 Key 累计消费：${quota(s.token.usedQuota)}`);
    }
    if (!s.token.unlimited) lines.push(`当前 Key 剩余额度：${quota(s.token.availableQuota!)}`);
  }
  if (s.period) {
    const p = s.period;
    lines.push(`日期：${p.startDate}${p.startDate !== p.endDate ? ` 至 ${p.endDate}` : ""}（北京时间）`,
      "范围：当前 Key 的可查记录");
    if (p.count || p.refundCount) {
      lines.push(`消费合计：${quota(p.spentQuota)}（${p.count} 笔）`);
      if (p.refundCount) lines.push(`退款合计：${quota(p.refundQuota)}（${p.refundCount} 笔）`, `净消费：${quota(p.spentQuota - p.refundQuota)}`);
    } else lines.push("未查到该时段的消费记录，不代表实际消费为零。");
    lines.push(p.limited ? "提示：仅覆盖最近1,000条记录，统计可能不完整。" : "提示：按平台保留记录统计，非完整账单。");
  }
  if (s.recent) {
    lines.push(`当前 Key · 最近${s.recent.length}条`);
    if (!s.recent.length) lines.push("暂无可查记录。");
    for (const row of s.recent) lines.push(`${formatTime(row.time)}  ${row.type === 6 ? "退款 " : ""}${quota(row.quota)}\n${row.model}`);
    lines.push("仅展示近期记录，非完整账单。");
  }
  for (const message of new Set(s.issues.map(issue => `${issue.message}${issue.retryAt ? ` 可重试时间：${formatTime(issue.retryAt)}（北京时间）` : ""}`))) lines.push(`提示：${message}`);
  lines.push(`\n更新时间：${formatTime(s.queriedAt)}（北京时间）${s.stale ? "（旧缓存，刷新失败）" : ""}`);
  return lines.join("\n");
}
