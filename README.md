# OpenClaw new-api 余额查询插件

独立的 OpenClaw 原生插件，自动复用当前 Agent 的模型 Key，调用 new-api 现有只读接口。**不修改 new-api、不参与充值或扣费、不直接访问 new-api 数据库、不另起 HTTP 服务。**

版本：`0.2.0` · 作者：[freeleepm](https://github.com/freeleepm) · [MIT 许可证](LICENSE)。

这是第三方插件，非 OpenClaw 或 new-api 官方项目。项目地址：[freeleepm/openclaw-newapi-balance](https://github.com/freeleepm/openclaw-newapi-balance)。

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

- 支持基线：OpenClaw **2026.9.8**；0.2.0 在 **2026.9.9** SDK 下通过42项测试，并在 **2026.9.8** Gateway 上完成直接命令验收。当前构建使用 `2026.9.9`，不保证所有未来版本无需适配。Node.js `>=24.16.0 <25` 或 `>=26.1.0`。
- new-api 接口基线：`v1.0.0-rc.41`。其他版本需核对计费字段含义。
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
openclaw plugins install ./openclaw-newapi-balance-0.2.0.tgz --force --accept-capabilities
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
          "providers": {
            "your-newapi-provider": { "accountBilling": false }
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

`providers` 的键必须与现有 `models.providers` ID 一致；地址和 Key 仍由 OpenClaw 管理。只支持 HTTPS，拒绝重定向，不允许工具输入任意地址。支持 `/v1` 及部署路径前缀。

**`accountBilling: true` 是管理员的明确确认，不是自动检测结果。** 只有确认 new-api `DisplayTokenStatEnabled=false`、兼容 billing 接口返回账号额度时才启用。若设置改变，必须同步将此项关闭；不确认时仅显示 Key 信息，避免把 Key 额度误标为企业余额。

不确定成员身份时，保留 `allowedSenders: []`，不要使用通配符。

上例默认 `accountBilling: false`，先只查 Key 信息。确认账户接口口径后才能设为 `true`；不要为了适配插件而修改 new-api 的计费配置。飞书成员示例为 `{ "channel": "feishu", "senderId": "YOUR_FEISHU_OPEN_ID" }`，应使用当前机器人所识别的真实发送者标识，不能填昵称。

### 3. 验证

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
