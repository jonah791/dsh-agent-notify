<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 出外告警的唯一通道：以服务形式向主人推送告警（Telegram 双通道 + 去重/冷却 + 落盘留痕），供任何插件在「我不在场」时把话喊出机器
  inject: （无 —— 本插件是通道，不是消费者）
  tools: （无工具 —— **Service 型**，对外提供 cordis 服务 `notify`）
  runtime: host-only
  envDeps: Telegram 凭据（bot token + chat id，住在组合 patch，**不进源码**）
  boundary: **只送不判**——不判断「何时该告警」、不生成内容、不重试、不触发任何恢复动作（尤其不自动 rearm goal）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-agent-notify

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-notify"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-37%20passed-brightgreen" alt="tests">
</p>

**一句话**：**出外告警的唯一通道**——任何插件都能通过它，在「我不在场」时把话喊出机器。

**为什么值得用**：多个插件各自实现推送 ⇒ 凭据散落、去重各写、失败各吞。本插件把它收成**一个 service**：Telegram 双通道 + 去重/冷却 + 落盘留痕。⚠ 它**只送不判**：`title` / `lines` 由调用方撰写——机制送信号，**决策归主体**（AGENTS.md §2.1）。

## 服务（本插件的对外契约）

本插件**不注册工具**——它是 Service 型。对外提供 cordis 服务 `notify`：

```ts
interface NotifyService {
  alert(input: { title: string; lines: string[]; dedupKey: string }): Promise<NotifyResult>
  ready(): { ok: boolean; detail: string }
  readonly name: string
}
```

消费者在自己的 `inject` 里声明 `'notify'`（cordis 严格代理：未声明即访问会抛错；**声明后提供者未挂载时才是 `undefined`**，故消费者须处理降级）。

**它只送不判**：`title` / `lines` 由调用方撰写——本插件不判断「何时该告警」，也不生成内容（AGENTS.md §2.1：机制送信号，决策归主体）。它也不重试、不触发任何恢复动作（尤其不自动 rearm goal）。

完整契约（配置字段 / 不变量 / 调用点 / 验收清单 / 未决问题）见 [`docs/semantic.md`](docs/semantic.md)。

## 生态契约

> 依据《DSH 插件生态倡议书》三条原则：**组合优先 / 声明清晰 / 兼容优先**。

- **依赖 service**（`inject`）：**无**——本插件是通道，不是消费者；不读任何宿主服务
- **贡献面**：工具 **无**；slot 无；service **`notify`**
- 组合行 id：`agent-notify`
- **Fabric manifest**：`dsh-plugin.json`（RFC 0001 v0.1 **Draft** 形状）——`id` = `com.jonah791.agent-notify`，required = （无），optional = （无）
- **Fabric 入口**：`src/fabric.ts` → `lib/fabric.js`（骨架，**不依赖 DSH/Cordis**；Fabric SDK 发布后填充实现）

> ⚠ **不是认证**：Fabric 目前只有文档草案（无正式 schema、无 SDK、无 conformance 套件），因此**不得**声称本插件
> 「通过 Fabric 认证」或「已符合 Fabric 标准」。对齐的是 RFC 0001 的 manifest 形状 + 可机械校验的明文规则；
> `dsh-plugin.json` 的 `$schema` 是**自证 draft 的占位**，Phase 0 发布 canonical identifier 后替换。

组合片段（`cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-notify
      name: dsh-agent-notify
      config: {}
```

## 能力边界（诚实声明）

本插件与宿主**同进程、全权限**运行。「能力声明」用于兼容判断、用户确认与审计，**不构成安全沙箱**——不要把它当权限边界。
本插件不导入其他插件或宿主的内部路径（组合优先），也不覆盖别人的内部实现。

### 两个面，别混淆

- **Fabric 契约面**：`dsh-plugin.json` + `src/fabric.ts`（host entrypoint）。这是**前瞻声明**——Fabric 目前只有 RFC Draft，
  没有正式 schema / SDK / conformance 套件，官方 `docs/plugin-development.md` 明示其**尚不能作为依赖或发布目标**；
  `$schema` 是自证 draft 的 `.invalid` 占位（RFC §14-1 未定 canonical identifier），**不是** schema 校验通过，也**不是**认证。
- **DSH/Cordis 面（非标准扩展路径）**：`src/index.ts` + `cordis.patch.yml`——本插件**现在真正可运行**的形态。
  `tools` 不在 Fabric v0.1 的 capability 表内（v0.1 只有 host.info / log / 生命周期取消 + `storage.local` / `commands` / `messages.observe`），
  故这属标准之外的扩展路径：**不得**当作可移植 API，也**不得**成为 Fabric entrypoint 的依赖。

## 构建与挂载

```sh
pnpm build
# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）
```

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-agent-notify": "link:E:/alice/self-plugins/dsh-agent-notify"
```

**2) 挂组合**（⚠ 凭据只写在 patch 里，**不进源码**）：

```yaml
- id: agent-notify
  name: dsh-agent-notify
  config:
    botToken: "<你的 bot token>"
    chatId: "<目标 chat id>"
```

**3) 30 秒验证**：`notify.ready()` → 应返回 `{ok: true, detail: "…"}`；再让某个消费者 `alert({title, lines, dedupKey})` → 主人应收到一条 Telegram 消息，且**同 `dedupKey` 的重复告警被冷却挡住**。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `botToken` | — | Telegram bot token（**只写组合 patch**，不进源码、不进仓库） |
| `chatId` | — | 目标 chat id |
| （去重/冷却窗口等见源码 `Config`） | — | 同 `dedupKey` 在窗口内只发一次 |

## 落盘与自证

| 文件 | 何时写 | 内容 |
|---|---|---|
| `${DSH_HOME}/notify-trace.jsonl` | 每次 `alert` | 标题 / 去重键 / 是否真发（被冷却挡住的不算发送） |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/notify-trace.jsonl"
# ① 跑的是哪个构建 → 见 package.json version 与 lib mtime
# ② 谁发起        → 该行的 title 与调用方
# ③ 断在哪一段    → 有行未发 = 被冷却；无行 = 没人调用过
# ④ 结果质量      → 是否真发（sent true/false）
# ⑤ 耗时与预算    → 发送延迟
```

## 生效判据与回退

**判据**：① 行为级——`notify.ready()` 返回 `{ok:true}`；② **端到端**——真发一条告警并收到。
**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`（消费者会拿到 `undefined`，须处理降级）；③ 无持久状态，停用即完全静默。

## 测试

```bash
cd self-plugins/dsh-agent-notify && npm test
```

**37 条用例**（跑一次得到）：覆盖**双通道**发送与降级 · **去重/冷却**（同键窗口内只发一次）· 凭据缺失时的响亮失败 · 发送失败入 outbox（**防丢**）· 侧车格式。无需真实网络（走注入的假 transport）。

## 设计要点

- **只送不判**：`title` / `lines` 由调用方撰写——本插件不判断「何时该告警」，也不生成内容（§2.1：机制送信号，决策归主体）。
- **它是唯一通道**：多个插件各自实现推送 ⇒ 凭据散落、去重各写、失败各吞。收成一个 service 才能统一去重与留痕。
- **不重试、不触发恢复**：尤其**不自动 rearm goal**——「把话喊出去」与「替人做决定」是两件事。
- **消费者须处理降级**：cordis 严格代理下未声明即访问会抛错；**声明后提供者未挂载时才是 `undefined`**。
- **凭据只住 patch**：源码与仓库里没有 token（这是隐私纪律的硬要求）。

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。
