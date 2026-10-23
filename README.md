# OpenClaw new-api 余额查询插件

独立的 OpenClaw 原生插件，自动复用当前 Agent 的模型 Key，调用 new-api 现有只读接口。**不修改 new-api、不参与充值或扣费、不直接访问 new-api 数据库、不另起 HTTP 服务。**

版本：`0.4.0` · 作者：[freeleepm](https://github.com/freeleepm) · [MIT 许可证](LICENSE)。

这是第三方插件，非 OpenClaw 或 new-api 官方项目。项目地址：[freeleepm/openclaw-newapi-balance](https://github.com/freeleepm/openclaw-newapi-balance)。

## 0.4.0：同一平台统一设置

在插件配置中增加 `platforms`，由管理员按平台确认一次返回口径。例如：

```json
{
  "platforms": {
    "https://your-platform.example/v1": { "billingScope": "account" }
  }
}
```

同一 OpenClaw 实例里，使用此 API 地址的所有供应商与 Agent 自动复用该设置，不必逐个填写 `accountBilling`。匹配包括协议、主机、端口和部署路径，仅规范化末尾 `/v1` 与斜杠；不按模糊域名匹配。地址必须为 HTTPS。平台级设置优先于旧供应商设置；旧 `providers` 配置继续兼容。

平台配置只共享**查询口径**，不共享 Key：每个 Agent 仍通过自己的当前会话及凭据解析查询。未知平台不会自动获准查询。`billingScope: "token"` 表示只能显示 Key 信息，不将其误报为账户余额。管理员需确认 new-api 的实际设置；本插件不修改 new-api，平台改动口径后需同步更新配置。

本次保留 0.3.0 的积分不足提示、成员名单和群聊限制。升级只作用于安装插件的实例，不会自动同步其他机器。安装包文件名为 `openclaw-newapi-balance-0.4.0.tgz`。

## 使用效果

在已授权的私聊中发送 `/balance`，返回类似内容（以下为虚构示例）：

```text
账户余额
可用余额：¥128.50
账户累计消费：¥371.50

更新时间：2026-10-09 09:30:00（北京时间）
```

当当前 Key 的累计消费与账户不同，额外显示“当前 Key 累计消费”；仅有限额 Key 显示独立剩余额度。账号余额与 Key 限额不是同一个概念。

**时段查询不是完整账单。** 当前适配接口只提供最近最多1,000条记录。插件只能汇总其中落在指定日期内的记录，不能补齐更早或已清理的历史，也不能合并其他 Key 的消费。

## 查询命令

| 命令 | 内容 |
|---|---|
| `/balance` | 账户余额与累计消费 |
| `/balance usage` | 当前 Key 最近最多10条消费/退款记录 |
| `/balance today` | 今日可查消费 |
| `/balance yesterday` | 昨日可查消费 |
| `/balance month` | 本月可查消费 |
| `/balance last7days` | 含今天在内的近7个自然日 |
| `/balance usage 2026-10-01` | 指定一天 |
| `/balance usage 2026-10-01 2026-10-08` | 指定日期范围，包含起止日 |

所有日期按北京时间。也可在已授权私聊中说“查询我的余额”“查本月消费”，由 Agent 调用查询工具；自然语言方式需要模型运行，可能产生模型费用，**直接 `/balance` 命令不调用模型**。

## 支持范围

- 最低兼容声明：OpenClaw **2026.9.8**；当前构建使用 **2026.9.9** SDK。0.4.0 已通过52项测试，在 **2026.10.1** Gateway 上完成14个 Agent 的管理员直接命令验收，模型消耗为0。不保证所有未来版本无需适配。Node.js `>=24.16.0 <25` 或 `>=26.1.0`。
- new-api 接口基线：`v1.0.0-rc.41`；0.4.0 的远程余额验收使用 `rc.45`。其他版本需核对计费字段含义，不能仅凭版本号假定接口始终返回账号余额。
- `/balance`：账号可用余额、账号累计消耗、当前 Key 累计消耗和额度。
- `/balance usage`：最近最多 10 条消耗/退款记录。
- `/balance today`、`yesterday`、`month`、`last7days`：今日、昨日、本月、近7天的可查消费；也支持“今日”“昨日”“本月”“近7天”。
- `/balance usage 2026-10-01 2026-10-08`：按日期汇总；仅填写一个日期时查询当天。日期按北京时间，包含起止日，今天截至查询时刻。
- 自然语言工具：`newapi_balance` 参数为空；`newapi_usage` 可传 `period: "today" | "yesterday" | "month" | "last7days"`，或 `startDate` / `endDate`（不能混用）；无参数仍返回最近10条。
- 用户回复隐藏底层平台名、供应商和凭据摘要，金额保留两位小数，日期统一 `YYYY-MM-DD HH:mm:ss` 北京时间。相同的账号/Key累计消费合并显示，无限额说明默认不展示。
- 无模型调用的直接命令；模型因余额不足不能回答时，仍可尝试查询。
- 所有者或指定成员才可查询，群聊默认拒绝；权限不足时不发起平台请求。

## 两种身份不要混淆

**模型 Key 决定查谁的账；聊天发送者 ID 决定谁有权看。** 插件不要求重新绑定或复制模型 Key。

`allowedSenders.senderId` 是 Telegram、飞书等聊天平台的用户标识，**不是 new-api 用户 ID、企业 ID、Agent ID 或 Key**。相同字符串在不同渠道不视为同一个人。可选 `agentIds` 可把成员限制在指定 Agent；省略时表示允许该成员查询其当前会话路由到的 Agent。

权限来源：

1. 明确配置的 `commands.ownerAllowFrom`（准确 ID 或 `渠道:ID`；不接受 `*`）。
2. 本插件 `allowedSenders` 的准确渠道与用户 ID。
3. 直接命令来自带 `operator.admin` 权限的可信 `webchat/internal` 控制端。

不把“渠道允许聊天”自动等同于“允许查看账务”，也不把宽松默认下的 owner 标记作为唯一依据。自然语言工具缺少可信发送者 ID 时拒绝查询；此时请使用管理控制端的 `/balance` 或配置成员。

## 安装与配置

### 1. 准备环境与安装包

需要已运行的 OpenClaw，以及已在 OpenClaw 中配置好 HTTPS 地址和模型凭据的 new-api 供应商。**不需要修改 new-api，也不需要把模型 Key 再写进插件配置。** 安装前备份 OpenClaw 配置和已有插件。

从本仓库构建，不假设插件已发布到 npm 或 ClawHub：

```sh
git clone https://github.com/freeleepm/openclaw-newapi-balance.git
cd openclaw-newapi-balance
npm ci --ignore-scripts
npm test
npm pack
openclaw plugins install ./openclaw-newapi-balance-0.4.0.tgz --force --accept-capabilities
```

### 2. 合并授权配置

本地包属于非 ClawHub 来源。仅对已核对的本项目安装包使用 `--force` 确认来源、`--accept-capabilities` 接受清单声明的两个工具；这不是跳过安全检查。本地自制包没有官方插件发行来源认证，检查输出中的 `provenance-invalid` 不等于加载失败，应同时查看注册状态、能力确认和诊断。安装后合并以下配置，**不要覆盖已有的插件或供应商配置**：

```json
{
  "plugins": {
    "entries": {
      "openclaw-newapi-balance": {
        "enabled": true,
        "config": {
          "platforms": {
            "https://your-platform.example/v1": { "billingScope": "account" }
          },
          "allowedSenders": [
            { "channel": "telegram", "senderId": "YOUR_TELEGRAM_USER_ID", "agentIds": ["YOUR_AGENT_ID"] }
          ],
          "cacheSeconds": 60,
          "timeoutMs": 8000
        }
      }
    }
  }
}
```

如果设置了 `plugins.allow`，还需加入 `openclaw-newapi-balance`。如 Agent 设置了严格的工具白名单，也需允许这两个工具或插件。官方安装流程若提示已实时应用，无需重复启动另一个 Gateway；需要重启时，使用原有服务管理方式，例如 systemd 或 launchd。

将示例 URL 替换为现有 `models.providers` 中的真实 `baseUrl`，成员占位符替换为真实渠道 ID。`platforms` 的配置位于插件的 **`config` 内**，不是 OpenClaw 顶层。同一平台可有多个供应商名称，不必逐个加入 `providers`。地址和 Key 仍由 OpenClaw 管理；插件配置不保存 Key。只支持 HTTPS，拒绝重定向，支持部署路径前缀。

**`billingScope: "account"` 是管理员对平台的一次性确认，不是自动探测结果。** 只有确认 new-api `DisplayTokenStatEnabled=false`、兼容账单接口返回账号额度时才使用。若接口返回 Key 额度，使用 `"token"`，此时仅查询 Key 信息。平台变更口径后需同步更新插件配置，不要为了适配插件而修改 new-api 的计费设置。

不确定成员身份时，保留 `allowedSenders: []`，不要使用通配符。

飞书成员示例为 `{ "channel": "feishu", "senderId": "YOUR_FEISHU_OPEN_ID" }`，应使用当前机器人所识别的真实发送者标识，不能填昵称。示例中的 `agentIds` 是可选限制：需要同一成员查询多个 Agent 时，添加相应 Agent ID，或在确认授权范围后省略此字段。

### 从旧配置升级

1. 备份原插件与 OpenClaw 配置，安装0.4.0包。
2. 在原插件 `config` 中合并 `platforms`，保留 `allowedSenders`、缓存参数及已有 `quotaNotice`，不要用示例覆盖整个配置。
3. 平台匹配时，`billingScope` 优先于旧 `providers.<供应商>.accountBilling`。没有平台匹配时，仍兼容旧配置；新配置不需要逐个填写 `accountBilling`。
4. 每个独立 OpenClaw 实例都需要安装和配置；不会自动同步其他机器。按下面的方法验证每个需要查询的 Agent。

如果启用了可选的积分不足提示，先保留旧 `providers` 项：该提示模块目前仍按供应商 ID 筛选，详见文末说明。它与余额查询的平台匹配是两个独立功能。

### 验证安装

```sh
openclaw config validate --json
openclaw plugins list
```

确认插件已加载，再由授权成员在私聊中发送 `/balance` 和 `/balance today`。不使用管理员 Key，不把用户 Key 发进聊天，不放宽群聊限制来绕过身份校验。

## 自然语言工具接口

插件保持两个工具名，以兼容已有 Agent 配置：

```json
{}
```

上述为空参数的 `newapi_balance`，用于查询余额。`newapi_usage` 的示例参数：

```json
{ "period": "month" }
```

```json
{ "startDate": "2026-10-01", "endDate": "2026-10-08" }
```

`period` 与自定义日期不能同时使用；不传日期时查询近期10条。工具不接受 Key、服务器地址、供应商或任意用户 ID。Agent 必须保留“当前 Key”“可查记录”“统计可能不完整”等范围说明，不得把部分记录改写成完整月账单。

## 凭据如何自动选择

- 工具优先使用可信运行上下文的当前供应商；直接命令读取当前会话的模型覆盖，再使用该 Agent 的默认模型。
- Key 通过 OpenClaw 的凭据解析机制取得，支持已有的配置/凭据档案；未解析的 SecretRef 不会发送给平台。
- 同一供应商存在多个凭据而没有明确选择时，拒绝猜测；先在 OpenClaw 选择凭据再查。
- 当前供应商不在插件允许范围时，不回退去查询另一个企业。
- 直接命令显示的是当前会话所选模型的计费凭据，不承诺等于上次失败重试/自动备用模型实际使用的 Key。自然语言工具则使用当前运行模型上下文。
- 同一企业多个 Key 可共享账号余额，各 Key 的消耗分开统计；多个 Agent 共用 Key 时无法准确拆分 Agent 消耗。

## 数据口径与限制

| 内容 | 接口 / 口径 |
|---|---|
| 平台显示单位、兑换比例 | `GET /api/status` |
| 当前 Key 额度与累计消耗 | `GET /api/usage/token/` |
| 账号可用余额 | `GET /v1/dashboard/billing/subscription` 的 `hard_limit_usd` 减去 `GET /v1/dashboard/billing/usage` 的 `total_usage / 100` |
| 近期记录 | `GET /api/log/token`，当前版本最多返回最近 1,000 条，再筛选最近 10 条消耗/退款记录 |
| 时段可查消费 | 同一接口返回的记录在插件内按北京时间筛选后汇总；不发送接口不支持的日期或分页参数 |

- 兼容接口的 `usd` 字段名不代表永远是美元。本插件按 `/api/status` 的 `quota_display_type`、`quota_per_unit`、`usd_exchange_rate` 解释 CNY、USD、TOKENS。
- 账号余额来自两次请求，不是原子快照；持续扣费时可能有轻微差异。日期范围不受这些累计 billing 接口支持。
- Key 不限额不等于账号余额无限；无限额 Key 的负额度字段不作为账号余额展示。
- 时段统计只针对当前 Key，不是账号所有 Key、所有 Agent 的合计。消费按 type=2 的原始 quota 相加；rc.41 的 type=6 退款为正值，单列退款并从消费中扣除得到净消费。出现不符合此约定的负退款时拒绝汇总，不猜符号。不把显示后四舍五入的单笔金额用于求和。
- 日志可能被清理、关闭记录或截断，所有时段统计都标注“可查记录”，不承诺完整账单。返回数量达到1,000条时明确提示可能不完整，即使最早记录看似覆盖起始日也不假定完整。未查到记录不显示为“实际消费0元”。
- 保持只使用模型 Key 和既有只读接口；未引入管理员凭据、数据库直连或历史采集服务。在此前提下无法保证任意时段的完整历史消费。
- 已停用、撤销、过期或额度耗尽的 Key 可能被部分接口拒绝。直接命令只绕过模型调用，不绕过平台认证。

## 缓存与安全

- 默认缓存 60 秒，同一凭据并发查询合并，缓存按 API 地址、供应商、完整 Key 摘要、查询模式和日期范围隔离。更新时间保留实际采样时间，缓存结果不伪装为即时数据。
- 不展示 Key 字符或短摘要标识。最多保存 128 份内存快照，进程退出即失效。
- 429 按服务器 `Retry-After` 等待，同一平台的其他 Key 也暂停，避免共享 IP 限流下反复冲击。没有后台轮询。
- 缓存未过期时不会再次认证；Key 撤销最多可能有缓存 TTL 的显示延迟。遇到刷新限流，只允许返回五分钟以内且标注旧时间的缓存。
- 上游原始错误、IP、提示词和日志扩展字段不返回给模型。查询失败不显示成余额为零。
- 插件是本地可信代码，不能防御能修改 OpenClaw 配置或读取其凭据的服务器管理员。

## 验证、排错与卸载

```sh
npm test
openclaw config validate --json
openclaw plugins list
```

在授权私聊或管理控制端分别运行 `/balance`、`/balance usage`。若报“无法确认私聊/身份”，检查渠道是否提供可信会话、发送者上下文及成员配置，不要通过放宽到所有人解决。若报“多个凭据”，先明确选择凭据；若报 429，等待显示的重试时间。

常见问题：

- **“当前平台暂未开通账户余额查询”**：检查该 Agent 实际选中的供应商 `baseUrl` 是否匹配 `platforms`，以及已确认的平台口径是否为 `account`。不要只检查主 Agent；会话中切换模型也会改变查询对象。
- **新机器人不能查**：检查它所在的 OpenClaw 实例是否已升级，并检查成员 `agentIds` 是否限制了该机器人。
- **配置更新后仍是旧提示**：检查正式服务使用的插件路径和运行版本，确认配置已应用；需要重启时使用原服务管理器，不另起实例。
- **不同机器人余额相同**：可能属于同一账号，或复用了同一个 Key；平台配置本身不会把不同 Key 合并。

卸载前可先将插件 `enabled` 设为 `false` 并按部署方式重启 Gateway；随后使用 `openclaw plugins uninstall openclaw-newapi-balance`，按 CLI 提示移除插件记录。不会删除 new-api 数据或模型 Key。保留安装前备份，以便恢复 OpenClaw 配置。

升级前备份原插件和配置，再使用经过审核的新包执行安装，核对授权名单和模型配置未变。失败时恢复旧包及备份配置；不需要回滚或改动 new-api。

## 开发与贡献

```sh
npm ci --ignore-scripts
npm test
npm run build
npm pack --dry-run
```

源码位于 `src/`，测试位于 `test/`；`openclaw.plugin.json` 声明插件能力与配置。`dist/` 是构建输出，不提交 Git，但会进入安装包。测试使用模拟凭据和响应，不需要生产 Key。

测试覆盖金额换算、两位小数、北京时间边界、退款、记录截断、缓存隔离、并发合并、限流和访问控制。真实飞书/Telegram 投递与身份识别仍需在各自环境验收，单元测试不等同于全渠道端到端认证。

欢迎通过 [Issues](https://github.com/freeleepm/openclaw-newapi-balance/issues) 反馈问题。请提供版本、脱敏后的提示和复现步骤；**不要上传 Key、密码、完整配置、聊天用户标识或原始账单**。与特定机器有关的部署记录、维护脚本和备份不进入公开仓库。

## 许可证

Copyright © 2026 [freeleepm](https://github.com/freeleepm)。按 [MIT](LICENSE) 许可证开源；使用和分发时保留版权及许可声明。


## 可选：账户积分不足提示（0.3.0 起支持）

在原插件配置中新增：

```json
{
  "providers": { "your-newapi-provider": {} },
  "quotaNotice": {
    "enabled": true,
    "message": "积分不足，请联系管理员充值。"
  }
}
```

上述字段合并到插件 `config`，不要删除已有 `platforms` 和授权名单。提示模块目前只匹配 `providers` 中明确列出的供应商 ID，因此仅配置平台即可查余额，但若要替换该供应商的积分不足错误，还须列出它的 ID。平台口径优先，所以这里不需要重复设置 `accountBilling`。

并在 `plugins.entries.openclaw-newapi-balance.hooks` 中配置 `allowConversationAccess: true`。
该权限用于读取 SDK 生成的失败消息；本模块不扫描历史会话、不保存聊天内容或 Key。
未启用时保持原行为。通知面向正常获得渠道回复的用户；账务明细查询权限保持原有配置。

实际复现基线为 new-api rc.43：账户零余额返回 HTTP 403 / `insufficient_user_quota`。
当前 OpenClaw 模型适配器会丢弃 JSON code，保留 HTTP 状态和本地化 message；因此只匹配已验证的严格中英文账户错误格式，不使用泛化 billing、403 或“余额不足”关键词。
Key 零额度在该版本可能返回与失效 Key 一样的 HTTP 401 / Invalid token，无法可靠区分，故不映射为充值提示。

本模块观察当前模型尝试，按 sessionKey/runId 关联新产生的失败 assistant 消息，仅替换最终 `isError` 回复。
备用模型成功、普通模型文本、用户输入、历史错误及没有可靠关联的投递保持原样。
状态仅保存内存，最多512项，10分钟过期。提示不包含原错误、余额数字或平台信息。
充值后新模型尝试重新判断，不使用“已欠费”永久锁定状态；未新增余额轮询。

无需为测试耗尽真实余额；验收使用独立网络命名空间、独立 SQLite 和虚构账号，禁止触及生产账号及上游计费。
