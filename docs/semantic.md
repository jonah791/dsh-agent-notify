# dsh-agent-notify · 语义文档

> 元信息：版本 v0.1 · 状态 draft · 最近复核 2026-10-09 · owner agent-notify

## 1 · 定位与反定位

**是什么**：出外告警的**唯一通道**——以 cordis 服务 `notify` 的形式，把调用方已经决定要说的话送到机器外面去（Telegram 主通道 node-fetch + 兜底 curl），带去重/冷却与落盘留痕。

**不是什么**：
- **不是判据**：本插件**不判断「何时该告警」**，也不生成告警内容。`title` / `lines` 由调用方撰写（AGENTS.md §2.1：机制送信号，决策归主体）。想知道「我是否长时间不在场」，那是 `dsh-life-core` 的判据，不是本插件的。
- **不是自动恢复器**：不在失败后排队重发，不触发任何「恢复」动作（尤其**不得自动 rearm goal**——那是有授权才有的事，见 `goal-rearm` I1）。
- **不是消息总线**：不订阅事件、不注册定时器、不含任何常驻轮询。一次调用 = 一次投递尝试。
- **不是沙箱**：capability ≠ 沙箱（本插件与宿主同进程、全权限，见 §5）。

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 出外告警 | 落到**机器之外**、我不在场时也能被主人看到的通知；`life-log.jsonl` 等进程内文件**不算**（我不醒时无人读它） |
| 去重键 dedupKey | 一条告警的稳定标识（如 `absence`）。同键在冷却窗口内只发一次；**换键可绕过冷却**（新故障应当立刻可见） |
| 冷却窗口 cooldownMs | 同键两次投递之间的最小间隔。非法值（0/负/NaN）一律**拒绝发送**，不退化为「每次必发」 |
| 抑制 suppressed | 去重命中导致的**主动不发**——是成功路径（`ok:true`），不是失败 |
| 干跑 dryRun | 不碰网络，把载荷追加到 `dryRunPath`。用于验收与调试，**不占主人带宽** |

## 3 · 概念模型与不变量

```
调用方（如 dsh-life-core）
   │  撰写 title/lines + 给 dedupKey
   ▼
notify.alert(input)  ──┬─► decideSend（纯）── 抑制 ─► 返回 suppressed + 留痕
                       │
                       └─► composeAlertText（纯）──► sendTelegramAlert（IO）
                                                        │ node-fetch 主通道
                                                        │ curl 兜底
                                                        ▼
                                                   Telegram → 主人
```

不变量（必须永远为真）：

1. **只送不判**：插件不生成、不改写告警内容；`title`/`lines` 原样来自调用方。
2. **拒绝也要说得出理由**：`decideSend` 的任何分支 `reason` 非空；发送失败一律返回 `ok:false` + 原因，不静默成功、不空吞。
3. **非法冷却不得退化为刷屏**：`cooldownMs <= 0` 或非有限数 → 拒绝发送（不是「每次必发」）。
4. **留痕覆盖成功、失败与被抑制三条路径**：每次调用追加一行到 `notify-trace.jsonl`。
5. **绝不冒泡**：`alert()` 内部任何异常都被吞并落痕——调用方多半是定时器，抛出去就是炸 web（§5.24）。
6. **不自动重试、不自动行动**：不排队、不重发、不触发恢复动作。

## 4 · 契约

### 4.1 配置（Config schema）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `enabled` | boolean | `true` | 只认 `=== false`（未配置视为启用）；false 时挂载但**不 provide 服务** |
| `telegramBotToken` | string | `''` | bot token；为空时从 `${DSH_HOME}/.credentials.yaml` 的 `TELEGRAM_BOT_TOKEN` 兜底 |
| `telegramChatId` | string | `''` | 目标 chat id；兜底同上（`TELEGRAM_CHAT_ID`） |
| `proxy` | string | `http://127.0.0.1:16888` | 仅 curl 兜底通道使用（主通道走 env 代理变量） |
| `timeoutMs` | number | `15000` | 单通道超时 |
| `cooldownMinutes` | number | `30` | 同键冷却窗口 |
| `dryRun` | boolean | `false` | 干跑：不发网络，写 `dryRunPath` |
| `dryRunPath` | string | `''` | 干跑落点；`dryRun=true` 而此处为空 ⇒ 响亮失败（不静默丢弃） |
| `tracePath` | string | `''` | 留痕文件；空 ⇒ `${DSH_HOME}/notify-trace.jsonl` |

### 4.2 服务面（不是工具面）

本插件**不注册任何工具**——它是 Service 型。对外契约是 cordis 服务 `notify`：

```ts
interface NotifyService {
  alert(input: { title: string; lines: string[]; dedupKey: string }): Promise<NotifyResult>
  ready(): { ok: boolean; detail: string }
  readonly name: string
}
interface NotifyResult {
  ok: boolean
  channel: string   // 'node-fetch' | 'curl' | 'dry-run' | 'none' | 'suppressed'
  detail: string
  dedupKey: string
  text: string      // 组装好的正文（发送成功时同样返回，便于调用方核对说了什么）
}
```

消费者须在自己的 `inject` 里声明 `'notify'`（cordis 严格代理：未声明即访问会抛错；**声明后提供者未挂载时才是 `undefined`**，故消费者要处理 undefined 降级）。

### 4.3 调用点清单 [MUST]

| 调用点 | 位置 | 说明 |
|--------|------|------|
| `ctx.provide('notify', …)` | `src/index.ts`（`apply` 尾部） | 本插件提供的服务 |
| `sendTelegramAlert(...)` | `src/index.ts:alert` → `src/transport.ts` | 唯一出网点 |
| `decideSend(...)` / `composeAlertText(...)` | `src/index.ts:alert` → `src/notify.ts` | 两个纯决策步 |
| `appendFileSync(tracePath, …)` | `src/index.ts:writeTrace` | 留痕（双路径尝试） |
| **消费者（已接线）** | `E:\alice\self-plugins\dsh-life-core\src\index.ts`（`paceTimer`） | 任务 `t-5fd8f3e9` 已完成接线：`ctx.get('notify')` **惰性取**（不在 `apply` 期取——可选服务那时可能尚未挂载，取到的 `undefined` 会被误当成「没这个能力」而静默丢失）。判据在 life-core 的 `src/absence.ts`（在场证据，非「有没有 agent」） |

## 5 · 边界与信任

- **同进程全权限**：与宿主同进程，`capability ≠ 沙箱`。本插件不做能力收窄，也不声称做了。
- **凭据**：token/chatId 经 config 或 `.credentials.yaml` 读入，**不落记忆库、不落仓库、不进日志**；留痕只记正文长度与通道，不记凭据。
- **网络出口**：仅 `https://api.telegram.org`；主通道经 spawn node 子进程注入 `NODE_USE_ENV_PROXY`（EnvHttpProxyAgent **只在进程启动时**读该变量，进程内设置无效——这是主通道必须是子进程的原因）。
- **通道可用性的证据边界（诚实标注）**：本插件的测试**不碰网络**，因此**不能**证明 Telegram 通道可用。可用性证据来自它的前身——完全相同的传输实现在 `dsh-agent-watch` / `dsh-agent-sentinel` 里已生产送达过（三份 7783 B 副本，本插件是把这份能力收成服务）。
- **不做**：不做重试队列、不做事件订阅、不做自动恢复。

## 6 · 与既有机制的关系

- **收编重复**：此前该传输实现被复制在 `dsh-agent-watch` / `dsh-agent-sentinel` / `dsh-agent-guardian` **三处**（各 7783 B），且三者都只服务各自进程内逻辑 ⇒ **没有任何插件能程序化地把告警送出机器**。「我不在场」类告警的缺口正源于此。
- **与 `dsh-agent-telegram` 的分工**：后者是**模型面向的工具**（`telegram_send` 等，我主动调）；本插件是**程序面向的服务**（插件在我不在场时调）。两者不互相替代——工具需要我在场，服务不需要。
- **与 `coldstart-alert.json` 的分工**：后者是进程内文件，前置 `agents==0`；本插件是出外通道，服务「会话活着但我不在场」这一形态。
- **迁移未完成（如实）**：watch/sentinel/guardian 的三份副本**尚未**改吃本服务——那是一次独立的重构，需先证明本插件在其各自进程形态下等价（尤其 watch 是独立进程、不经 web 宿主）。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令/单测名/日志行） | 状态 |
|---|-----------|--------------------------|------|
| A1 | 纯决策层与壳层测试全绿 | `node --test "tests/*.test.mjs"` → 37 pass / 0 fail | ✔ 已实测（2026-10-09） |
| A2 | 非法冷却**拒绝发送**而非退化为每次必发 | 单测「尸体：cooldownMs=0 / 负数 / NaN → 拒绝发送」 | ✔ 已实测 |
| A3 | `exit 0 但 API ok=false` 被判失败（2026-09-11 实测过的误报形态） | 单测「尸体：exit 0 但 API ok=false → 判失败」 | ✔ 已实测 |
| A4 | 干跑端到端：首次落盘、同键第二次被抑制、落点仍 1 行 | 单测「壳层 drayRun 端到端」 | ✔ 已实测 |
| A5 | 三条路径都留痕（ready / sent / suppressed） | 单测「每次调用都留痕（含被抑制的那次）+ 装配自证行」 | ✔ 已实测 |
| A6 | 无凭据时失败响亮、不假称送达 | 单测「尸体：非干跑 + 无凭据 → 失败响亮」 | ✔ 已实测 |
| A7 | `enabled=false` 时不提供 `notify` 服务 | 单测「尸体：enabled=false → 不提供 notify 服务」 | ✔ 已实测 |
| A8 | **在真实 web 组合里挂载成功且服务就绪** | ✔ **已实测（2026-10-09 06:11:28）**：`notify-trace.jsonl` 首行 `{"stage":"ready","ok":true,"detail":"Telegram 通道就绪（主 node-fetch + 兜底 curl）"}`——装配成功且**凭据从 `.credentials.yaml` 兜底解析成功** | ✔ 已实测 |
| A9 | **消费者（life-core）能取到服务**（`ctx.get('notify')` 解析得到） | ✔ **已实测（2026-10-09 06:16:31）**：`life-log.jsonl` 落行「出外告警通道可达：notify 服务已装配（缺席阈值 360 分钟）」——进程起点 06:11:28 后首次 tick 即出，阈值 360 = 周期 180 × 倍数 2 也从配置读出。**惰性取 + 接线自证这条路走通了** | ✔ 已实测 |
| A10 | **端到端真送达**：一次真实的 >6h 缺席 ⇒ 主人收到 Telegram 告警 | 不可人为制造（清 `lastActiveAt` 会污染存在性证据本身）⇒ 只能等真事件 | **待线上验收（不可加速）** |
| A11 | 装配自证行必须**带结论**，不能只是一句「来了」 | 单测断言 `rows[0].ok` 是 boolean 且 `detail` 非空 | ✔ 已实测 |

## 8 · 与实现的关系

- 纯决策层：`src/notify.ts`（`decideSend` / `normalizeDedupKey` / `composeAlertText`，无 IO）。
- 传输层：`src/transport.ts`（`sendTelegramAlert` / `judgeTelegramResponse` / 干跑落点）。
- 壳层：`src/index.ts`（配置、凭据兜底、`ctx.provide`、留痕、异常吞噬）。
- 测试：`tests/notify.test.mjs`（判据 + 尸体）、`tests/smoke.test.mjs`（生成器骨架守卫，14 条）。
- 同语义副本：无（本插件是本能力的**首个**服务形态）。

## 9 · 实践修订记录

- **2026-10-09 首次成文**：由 `dsh-plugin-forge` 生成骨架后手写正文。触发背景是 `t-9d17c42c` 的裁决——生态里**没有任何可被程序调用的出外告警通道**，而「我不在场」的告警恰恰需要一个。同日给它写了 37 条测试（含 6 个尸体样本）。**未挂载**：避免为「服务存在但无消费者」付一次重启（重启本身正是 `t-9d17c42c` 所查事故的起因），挂载与消费者接线合并到下一次。
- **2026-10-09 挂载 + 接线**（同日稍晚）：`plugin_mount` 装入 web profile；life-core 的 `paceTimer` 成为首个消费者（判据 `src/absence.ts`）。**新增装配自证行**（§5.22 规则 1）：装配即向 `notify-trace.jsonl` 落一行 `ready` + `ready()` 的结论——本环境 web 进程 stdout **没有落点**，只写 `ctx.logger` 等于写进虚空；不留这一行，「通道装没装上、凭据解没解析出来」就只能靠推断。实测读数见 A8。

## 10 · 未决问题

- **U1 三份副本何时收编**：`dsh-agent-watch` / `dsh-agent-sentinel` / `dsh-agent-guardian` 里的 `alert-transport.ts` 副本尚未改吃本服务。`watch` 是**独立进程**（不经 web 宿主、不共享 cordis 容器），本服务对它不可见 ⇒ 它要么保留自己的副本，要么把传输抽成**不依赖 cordis** 的独立包。倾向后者，但需要先量清三处调用面的差异。
- **U2 去重状态的持久性**：`lastSent` 是**进程内**内存。web 重启后冷却窗口归零 ⇒ 若故障持续，重启会立刻再发一条。是否需要把去重状态落盘（并处理与 `notify-trace.jsonl` 的关系）尚未决定。
- **U3 是否需要「确认送达才罢休」**：现设计是一次尝试即返回结论（不重试）。若告警本身因网络原因丢失，不会有补偿。权衡：重试会增加复杂度与刷屏风险；暂不重试，但这条边界要写清。
- **U4 没有「主实例」门，预检试运行会往共享留痕里落行**（2026-10-09 实测）：一次重启在 `notify-trace.jsonl` 留下 **2 行** `ready`——06:11:06 那条来自**预检试运行的第二实例**（它同样挂载本插件），06:11:28 那条才是真 web。`coldstart.ts` 用 `isPrimaryInstance`（argv 无 `--port` 或等于 `primaryPort`）挡过同型问题（避免试运行往共享 `life-log` 写假痕迹）。本插件是否照抄这道门，取决于「同一份 trace 被两个实例写」会不会误导读数——目前只影响行数，不影响判据；倾向照抄（一致性优先），但先记着不急着改。
