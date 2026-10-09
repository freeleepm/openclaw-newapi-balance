import type { AnyAgentTool, OpenClawConfig, OpenClawPluginApi, OpenClawPluginToolContext, PluginCommandContext } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { getSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { ensureAuthProfileStore, listProfilesForProvider } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/agent-runtime";
import { apiRoot, BalanceError, parseConfig, PLUGIN_ID, publicError, type PluginConfig } from "./config.js";
import { formatSnapshot, NewApiClient, type Credential } from "./client.js";
import { assertAccess, type Identity } from "./policy.js";
import { formatTime, parseCommand, resolvePeriod, type Period, type UsageParams } from "./period.js";

const errorText = (error: unknown) => {
  const detail = publicError(error);
  return `${detail.message}${detail.retryAt ? ` 可重试时间：${formatTime(detail.retryAt)}（北京时间）` : ""}`;
};

interface Invocation {
  config: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  sessionKey?: string;
  storePath?: string;
  identity: Identity;
  activeProvider?: string;
  activeModel?: string;
  resolveKey?: (provider: string) => Promise<string | undefined>;
  assertCurrent?: () => void;
}

export function selectProvider(input: {
  config: PluginConfig;
  activeProvider?: string;
  sessionProvider?: string;
  defaultProvider?: string;
}): string {
  const provider = input.activeProvider || input.sessionProvider || input.defaultProvider;
  if (!provider || !Object.hasOwn(input.config.providers, provider)) {
    throw new BalanceError("PROVIDER", "当前模型暂不支持余额查询，请先切换到已开通查询的模型。");
  }
  return provider;
}

const sdk = { getSessionEntry, resolveAgentDir, ensureAuthProfileStore, listProfilesForProvider, resolveApiKeyForProvider };

export function createHandlers(api: OpenClawPluginApi, fetcher: typeof fetch = fetch, host: typeof sdk = sdk) {
  const initial = parseConfig(api.pluginConfig);
  const client = new NewApiClient(initial, fetcher);
  const pluginConfig = (config: OpenClawConfig) =>
    parseConfig(config.plugins?.entries?.[PLUGIN_ID]?.config ?? api.pluginConfig);

  async function run(invocation: Invocation, mode: "balance" | "usage", signal?: AbortSignal, period?: Period) {
    const { config, agentId, sessionKey } = invocation;
    if (!agentId) throw new BalanceError("AGENT", "无法确认当前会话所属 Agent，请从该 Agent 的私聊发起查询。");
    // Read one host-selected session through the supported read-only SDK; never scan other sessions.
    let entry: SessionEntry | undefined;
    if (sessionKey) {
      try { entry = host.getSessionEntry({ agentId, sessionKey, ...(invocation.storePath ? { storePath: invocation.storePath } : {}) }); }
      catch { throw new BalanceError("SESSION", "无法确认当前会话状态，暂不查询账务。"); }
    }
    const settings = pluginConfig(config);
    const identity = { ...invocation.identity, agentId, sessionKey, chatType: entry?.chatType };
    const owners = config.commands?.ownerAllowFrom?.filter((id): id is string => typeof id === "string") ?? [];
    assertAccess(identity, settings, owners);
    invocation.assertCurrent?.();
    const defaultModel = api.runtime.modelConfig.resolveDefaultModelForAgent({ cfg: config, agentId });
    const provider = selectProvider({ config: settings, activeProvider: invocation.activeProvider,
      sessionProvider: entry?.providerOverride, defaultProvider: defaultModel.provider });
    const providerConfig = config.models?.providers?.[provider];
    if (!providerConfig?.baseUrl) throw new BalanceError("CONFIG", "供应商没有明确的 API 地址，无法查询。");
    apiRoot(providerConfig.baseUrl);
    const agentDir = invocation.agentDir ?? host.resolveAgentDir(config, agentId);
    const store = host.ensureAuthProfileStore(agentDir, { config, readOnly: true });
    const profiles = host.listProfilesForProvider(store, provider);
    const profileId = entry?.authProfileOverride && profiles.includes(entry.authProfileOverride)
      ? entry.authProfileOverride : undefined;
    if (profiles.length > 1 && !profileId) {
      throw new BalanceError("AMBIGUOUS_KEY", "当前供应商配置了多个凭据，无法唯一确定计费账号；请先在 OpenClaw 中明确选择凭据。");
    }
    let apiKey: string | undefined;
    try {
      if (invocation.resolveKey && !profileId) apiKey = await invocation.resolveKey(provider);
      if (!apiKey) {
        const auth = await host.resolveApiKeyForProvider({ provider, cfg: config, agentDir, store,
          ...(profileId ? { profileId, lockedProfile: true } : {}),
          modelId: invocation.activeModel ?? entry?.modelOverride ?? defaultModel.model,
          modelBaseUrl: providerConfig.baseUrl, modelApi: providerConfig.api, signal });
        apiKey = auth.apiKey;
      }
    } catch { throw new BalanceError("CREDENTIAL", "无法读取该 Agent 的现有凭据，请检查 OpenClaw 凭据配置；无需向模型发送 Key。"); }
    if (!apiKey || !/^sk-[A-Za-z0-9_-]+$/.test(apiKey)) {
      throw new BalanceError("CREDENTIAL", "未找到可用的模型凭据，请联系管理员检查配置；无需发送 Key。");
    }
    const credential: Credential = { provider, baseUrl: providerConfig.baseUrl, apiKey,
      accountBilling: settings.providers[provider]!.accountBilling };
    const result = await client.query(credential, mode, signal, period);
    signal?.throwIfAborted();
    invocation.assertCurrent?.();
    // Re-check the invocation's host policy before disclosing cached or fetched data.
    assertAccess(identity, pluginConfig(config), owners);
    return result;
  }

  const command = async (ctx: PluginCommandContext) => {
    const args = (ctx.args ?? "").trim();
    try {
      const query = parseCommand(args);
      const result = await run({ config: ctx.config, agentId: ctx.agentId ?? ctx.sessionTarget?.agentId,
        sessionKey: ctx.sessionKey, storePath: ctx.sessionTarget?.storePath,
        identity: { channel: ctx.channelId ?? ctx.channel, senderId: ctx.senderId,
          gatewayClientScopes: ctx.gatewayClientScopes, isAuthorizedSender: ctx.isAuthorizedSender },
        assertCurrent: ctx.assertOwnerCurrent }, query.mode, undefined, query.period);
      return { text: formatSnapshot(result) };
    } catch (error) { return { text: errorText(error) }; }
  };

  const tools = (ctx: OpenClawPluginToolContext): AnyAgentTool[] => {
    return (["balance", "usage"] as const).map(mode => ({
      name: `newapi_${mode}`,
      label: mode === "balance" ? "查询账户余额" : "查询消费记录",
      description: mode === "balance"
        ? "使用当前 Agent 已配置的模型 Key，只读查询其所属账号余额和 Key 累计消耗。不得要求用户提供 Key；仅所有者或指定成员可在私聊使用。"
        : "查询当前模型 Key 的近期消费或指定日期消费。无参数返回最近10条；period 支持 today/yesterday/month/last7days；或 startDate/endDate（YYYY-MM-DD，北京时间，包含起止日）。仅汇总接口可查记录，不是完整账单，必须保留覆盖不足提示，不可称作整个账户的消费。不要展示供应商、凭据摘要或底层平台名称；金额保留2位小数。仅授权私聊可用，不接受 Key。",
      parameters: { type: "object", properties: mode === "balance" ? {} : {
        period: { type: "string", enum: ["today", "yesterday", "month", "last7days"] },
        startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "开始日期（北京时间）" },
        endDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "结束日期（含当日）；省略时查询开始日期当天" },
      }, additionalProperties: false } as AnyAgentTool["parameters"],
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        try {
          const allowed = mode === "balance" ? [] : ["period", "startDate", "endDate"];
          if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key))) {
            throw new BalanceError("ARGUMENTS", "查询工具不接受 Key、用户 ID、供应商或服务器地址参数。");
          }
          const period = mode === "usage" ? resolvePeriod(params as UsageParams) : undefined;
          const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config ?? api.config;
          const result = await run({ config, agentId: ctx.agentId, agentDir: ctx.agentDir, sessionKey: ctx.sessionKey,
            activeProvider: ctx.activeModel?.provider ?? ctx.activeModel?.modelRef?.split("/")[0],
            activeModel: ctx.activeModel?.modelId ?? ctx.activeModel?.modelRef?.split("/").slice(1).join("/"),
            resolveKey: ctx.resolveApiKeyForProvider, assertCurrent: ctx.assertInvocationCurrent,
            identity: { channel: ctx.messageChannel ?? ctx.deliveryContext?.channel,
              senderId: ctx.requesterSenderId } }, mode, signal, period);
          return { content: [{ type: "text" as const, text: formatSnapshot(result) }], details: result };
        } catch (error) {
          const detail = publicError(error);
          return { content: [{ type: "text" as const, text: errorText(error) }], details: { error: detail }, isError: true };
        }
      },
    }));
  };
  return { command, tools };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "余额与消费查询",
  description: "复用 Agent 的现有模型 Key，只读查询账号余额和当前 Key 用量。",
  configSchema: { parse: parseConfig },
  register(api: OpenClawPluginApi) {
    const handlers = createHandlers(api);
    api.registerCommand({ name: "balance", description: "查余额；today 今日消费；month 本月消费；usage 查记录或日期（仅授权私聊）",
      acceptsArgs: true, requireAuth: true, handler: handlers.command });
    api.registerTool(handlers.tools, { names: ["newapi_balance", "newapi_usage"] });
  },
});
