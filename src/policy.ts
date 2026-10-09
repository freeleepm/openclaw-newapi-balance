import { BalanceError, type PluginConfig } from "./config.js";

export interface Identity {
  channel?: string;
  senderId?: string;
  agentId?: string;
  chatType?: string;
  sessionKey?: string;
  gatewayClientScopes?: string[];
  isAuthorizedSender?: boolean;
}

export function assertAccess(identity: Identity, config: PluginConfig, explicitOwners: string[] = []): void {
  if (identity.isAuthorizedSender === false) throw new BalanceError("FORBIDDEN", "未获准使用此命令。");
  const { channel, senderId, sessionKey = "", chatType } = identity;
  // A group/session indicator always wins over a stale persisted direct-message hint.
  if (chatType === "group" || chatType === "channel" || /:(group|channel):/.test(sessionKey)) {
    throw new BalanceError("PRIVATE_ONLY", "账务查询仅在私聊中提供，请切换到私聊。");
  }
  const controlPlane = ["webchat", "internal"].includes(channel ?? "") &&
    identity.gatewayClientScopes?.includes("operator.admin") === true;
  const direct = chatType === "direct" || /:(direct|dm):/.test(sessionKey) || controlPlane;
  if (!direct) throw new BalanceError("PRIVATE_ONLY", "无法确认当前是私聊，暂不展示账务数据。");
  if (controlPlane) return;
  if (!channel || !senderId) throw new BalanceError("FORBIDDEN", "无法确认查询者身份，暂不展示账务数据。");
  const owner = explicitOwners.some(id => id !== "*" && !id.includes("*") &&
    (id === senderId || id === `${channel}:${senderId}`));
  const member = config.allowedSenders.some(item => item.channel === channel && item.senderId === senderId &&
    (item.agentIds === undefined || (!!identity.agentId && item.agentIds.includes(identity.agentId))));
  if (!owner && !member) throw new BalanceError("FORBIDDEN", "仅所有者或指定成员可查询账务，请联系管理员开通。");
}
