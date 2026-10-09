export const PLUGIN_ID = "openclaw-newapi-balance";

export interface Member {
  channel: string;
  senderId: string;
  agentIds?: string[];
}
export interface PluginConfig {
  providers: Record<string, { accountBilling: boolean }>;
  allowedSenders: Member[];
  cacheSeconds: number;
  timeoutMs: number;
}

export class BalanceError extends Error {
  constructor(public code: string, message: string, public retryAt?: number) {
    super(message);
    this.name = "BalanceError";
  }
}

export function parseConfig(raw: unknown): PluginConfig {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const providers: PluginConfig["providers"] = {};
  if (value.providers && typeof value.providers === "object" && !Array.isArray(value.providers)) {
    for (const [id, options] of Object.entries(value.providers)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(id) || !options || typeof options !== "object") {
        throw new BalanceError("CONFIG", "余额插件的供应商配置无效。");
      }
      providers[id] = { accountBilling: (options as Record<string, unknown>).accountBilling === true };
    }
  }
  const allowedSenders: Member[] = [];
  if (Array.isArray(value.allowedSenders)) {
    for (const member of value.allowedSenders) {
      if (!member || typeof member !== "object" || typeof member.channel !== "string" ||
          typeof member.senderId !== "string" || !member.channel.trim() || !member.senderId.trim() ||
          member.channel.includes("*") || member.senderId.includes("*") ||
          (member.agentIds !== undefined && (!Array.isArray(member.agentIds) ||
            member.agentIds.some((id: unknown) => typeof id !== "string" || !id || id.includes("*"))))) {
        throw new BalanceError("CONFIG", "查询成员必须指定渠道和用户 ID，不支持通配符。");
      }
      allowedSenders.push({ channel: member.channel.trim(), senderId: member.senderId.trim(),
        ...(member.agentIds !== undefined ? { agentIds: member.agentIds } : {}) });
    }
  }
  const bounded = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  return { providers, allowedSenders, cacheSeconds: bounded(value.cacheSeconds, 60, 10, 300),
    timeoutMs: bounded(value.timeoutMs, 8000, 1000, 15000) };
}

export function apiRoot(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new BalanceError("CONFIG", "供应商地址无效。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new BalanceError("CONFIG", "余额查询仅允许无用户名、密码或查询参数的 HTTPS 供应商地址。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/";
  return url.toString();
}

export function safeText(value: unknown, max = 80): string {
  return typeof value === "string" ? value.replace(/sk-[a-zA-Z0-9_-]+/g, "[已隐藏凭据]")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max) : "";
}

export function publicError(error: unknown): { code: string; message: string; retryAt?: string } {
  if (error instanceof BalanceError) {
    return { code: error.code, message: error.message,
      ...(error.retryAt ? { retryAt: new Date(error.retryAt).toISOString() } : {}) };
  }
  return { code: "UNAVAILABLE", message: "余额查询暂时不可用，请稍后重试；未将失败解释为余额为零。" };
}
