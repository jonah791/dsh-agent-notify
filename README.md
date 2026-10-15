# dsh-agent-notify

出外告警的唯一通道：以服务形式向主人推送告警（Telegram 双通道 + 去重/冷却 + 落盘留痕），供任何插件在「我不在场」时把话喊出机器

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
