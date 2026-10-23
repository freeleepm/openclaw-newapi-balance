import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { parseConfig, PLUGIN_ID, type PluginConfig } from "./config.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

/** Only SDK-generated failed assistant messages, never ordinary conversation text. */
export function isUserQuotaError(message: unknown): boolean {
  const m = record(message);
  if (m?.role !== "assistant" || m.stopReason !== "error" || typeof m.errorMessage !== "string") return false;
  const raw = m.errorMessage.trim();
  if (raw.length > 8192) return false;
  const json = raw.replace(/^403\s+/, "");
  try {
    const error = record(record(JSON.parse(json))?.error);
    if (error?.code === "insufficient_user_quota") return true;
  } catch { /* The 2026.10.1 adapter retains status/message, but drops the JSON code. */ }
  // Exact rc.43 account-quota prefixes, verified using an isolated instance.
  return /^403\s+(?:Insufficient user quota, remaining quota:\s*|用户额度不足,\s*剩余额度:\s*)[＄$¥￥]?\s*-?\d+(?:\.\d+)?(?:\s*\([^\r\n]*\))?$/i.test(raw);
}

function scope(event: RecordValue, ctx: RecordValue): string | undefined {
  const runId = event.runId ?? ctx.runId;
  const sessionKey = event.sessionKey ?? ctx.sessionKey;
  if (typeof runId !== "string" || !runId || typeof sessionKey !== "string" || !sessionKey) return;
  return JSON.stringify([sessionKey, runId]);
}

export function createQuotaNotice(getConfig: () => PluginConfig, now = Date.now) {
  const calls = new Map<string, { at: number; provider: string; exhausted: boolean }>();
  const ttl = 10 * 60_000;
  const prune = () => {
    for (const [key, value] of calls) if (now() - value.at > ttl) calls.delete(key);
    while (calls.size > 512) calls.delete(calls.keys().next().value!);
  };
  return {
    started(event: unknown, context: unknown) {
      const e = record(event) ?? {}, ctx = record(context) ?? {}, key = scope(e, ctx);
      prune();
      if (!key) return;
      calls.delete(key); // A fallback attempt must not inherit the previous failure.
      const config = getConfig();
      if (config.quotaNotice.enabled && typeof e.provider === "string" && Object.hasOwn(config.providers, e.provider)) {
        calls.set(key, { at: now(), provider: e.provider, exhausted: false });
      }
    },
    ended(event: unknown, context: unknown) {
      const e = record(event) ?? {}, ctx = record(context) ?? {}, key = scope(e, ctx);
      if (!key) return;
      const call = calls.get(key);
      if (!call || !Array.isArray(e.messages)) return;
      const last = [...e.messages].reverse().find(m => record(m)?.role === "assistant");
      const m = record(last);
      // Refuse historical errors when a new attempt fails before producing a message.
      call.exhausted = typeof m?.timestamp === "number" && m.timestamp >= call.at - 1000 &&
        m.provider === call.provider && isUserQuotaError(m);
    },
    sending(event: unknown, context: unknown) {
      const e = record(event) ?? {}, ctx = record(context) ?? {}, key = scope(e, ctx);
      prune();
      if (!key) return;
      const call = calls.get(key), payload = record(e.payload), config = getConfig();
      if (!config.quotaNotice.enabled || !call?.exhausted || !Object.hasOwn(config.providers, call.provider) ||
          e.kind !== "final" || payload?.isError !== true) return;
      // Preserve threading flags; remove any error content, attachments and channel cards.
      return { payload: {
        text: config.quotaNotice.message,
        isError: true,
        ...typeof payload.replyToId === "string" ? { replyToId: payload.replyToId } : {},
        ...typeof payload.replyToCurrent === "boolean" ? { replyToCurrent: payload.replyToCurrent } : {},
      } };
    },
  };
}

export function registerQuotaNotice(api: OpenClawPluginApi) {
  if (!parseConfig(api.pluginConfig).quotaNotice.enabled) return;
  const getConfig = () => parseConfig(api.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? api.pluginConfig);
  const notice = createQuotaNotice(getConfig);
  api.on("model_call_started", (event, ctx) => notice.started(event, ctx));
  api.on("agent_end", (event, ctx) => notice.ended(event, ctx));
  api.on("reply_payload_sending", (event, ctx) => notice.sending(event, ctx), { priority: -100 });
}
