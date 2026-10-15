/**
 * dsh-agent-notify — 出外告警的**唯一通道**（服务形态，不是工具形态）
 *
 * 为什么存在（2026-10-09 · `t-5fd8f3e9`）
 * ------------------------------------
 * 「我不在场」这类故障的处置链**只在我醒来后才生效**，而故障形态恰恰是「我没醒」。
 * 裁决（`t-9d17c42c`）显示：检测本身是有的（`dsh-life-core` 的 `paceTimer` 实测准点），
 * 缺的是**告警的出外通道**——`life-log.jsonl` 在我不醒时无人读，而唯一带外部落点的
 * `coldstart-alert.json` 前置 `agents==0`（故障形态恰恰是会话活着）。
 *
 * 本插件补的正是那一环：**一个能被程序调用的出外推送服务**。此前该能力不存在——
 * 完全相同的 7783 B 传输实现被复制在 `dsh-agent-watch` / `dsh-agent-sentinel` /
 * `dsh-agent-guardian` 三处，且三者都只服务于自己的进程内逻辑，没有任何插件能
 * 「在判定出我不在场时把话送出去」。
 *
 * 边界与不变量
 * ------------
 * - I1 **只送不判**：本插件不判断「何时该告警」、不生成告警内容——`title` / `lines` 由调用方
 *   撰写。机制送信号，决策归主体（AGENTS.md §2.1）。
 * - I2 **不自动重试、不自动行动**：一次调用 = 一次投递尝试。不在失败后排队重发，也不触发
 *   任何「恢复」动作（例如不得自动 rearm goal——那是有授权才有的事，见 `goal-rearm` I1）。
 * - I3 **失败响亮**：缺凭据 / 缺落点 / 双通道均失败，一律返回结构化 `ok:false` + 原因，
 *   不静默成功、不空吞。
 * - I4 **留痕**：每次调用（含被冷却抑制的）追加一行到 `${DSH_HOME}/notify-trace.jsonl`，
 *   一行一阶段，可 tail/grep（AGENTS.md §5.22 规则 1）。
 * - I5 **不抛**：任何异常都被吞并落痕，绝不冒泡到调用方的定时器（宿主内插件异常 = 炸 web，
 *   见 §5.24）。
 * - I6 **不改宿主**：不修改 DSH 源码，不替换任何官方包。
 *
 * ⚠ 天花板诚实：`dryRun` 能证明**判据触发且载荷被组装**，不能证明 Telegram 通道可用。
 * 通道可用性的证据来自它的前身（同一实现在 sentinel/watch 里已生产送达过）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { composeAlertText, decideSend, normalizeDedupKey, type AlertInput } from './notify.ts'
import { sendTelegramAlert, type AlertTransportResult } from './transport.ts'

export const name = 'agent-notify'
/** 不依赖任何宿主服务：本插件是通道，不是消费者。 */
export const inject = [] as const

export interface Config {
  enabled: boolean
  telegramBotToken: string
  telegramChatId: string
  /** curl 兜底通道的 http 代理（node-fetch 主通道走 env 代理变量） */
  proxy: string
  /** 单通道超时（ms） */
  timeoutMs: number
  /** 同键告警的冷却窗口（分钟） */
  cooldownMinutes: number
  /** 干跑：不发 Telegram，把载荷追加到 dryRunPath（验收/调试用，不占主人带宽） */
  dryRun: boolean
  dryRunPath: string
  /** 留痕文件路径（缺省 `${DSH_HOME}/notify-trace.jsonl`） */
  tracePath: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  telegramBotToken: z.string().default(''),
  telegramChatId: z.string().default(''),
  proxy: z.string().default('http://127.0.0.1:16888'),
  timeoutMs: z.number().default(15000),
  cooldownMinutes: z.number().default(30),
  dryRun: z.boolean().default(false),
  dryRunPath: z.string().default(''),
  tracePath: z.string().default(''),
})

/** 一次调用的结论（结构化，供调用方判断与留痕）。 */
export interface NotifyResult {
  ok: boolean
  /** 实际通道；`suppressed` = 被冷却抑制（不是失败） */
  channel: string
  detail: string
  /** 本次告警的规范化去重键 */
  dedupKey: string
  /** 组装好的正文（干跑/留痕用；发送成功时同样返回，便于调用方核对说了什么） */
  text: string
}

/** 宿主服务面（供其他插件 `inject: ['notify']` 消费）。 */
export interface NotifyService {
  alert(input: AlertInput): Promise<NotifyResult>
  /** 当前是否具备发送能力（配置齐全或干跑已配落点） */
  ready(): { ok: boolean; detail: string }
  readonly name: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    notify?: NotifyService
  }
}

/** 进程内最近一次实际发出的信息（去重状态；重启后从留痕重建由调用方按需自行处理）。 */
const lastSent: { atMs: number; dedupKey: string } = { atMs: 0, dedupKey: '' }

/**
 * 读 `.credentials.yaml` 兜底（与 sentinel/guardian 同款，保持凭据单一来源的习惯做法）。
 *
 * ⚠ **YAML 引号必须清洗**（2026-10-11 修复）：本函数原来用 `(\S+)` 取值，而凭据文件里的值
 * 带双引号（`TELEGRAM_BOT_TOKEN: "123:abc"`）⇒ 引号被吃进 token ⇒ Telegram API 返
 * **404 Not Found**（不是 401——这个错误码极易被读成「接口不对」而不是「token 脏了」）。
 * 实测代价：庄园存活巡检的告警**从未真正出过机器**（notify-trace 里 `双通道均失败：API 拒绝：Not Found`）。
 * 正解早就在 `dsh-agent-telegram` 里（它 2026-09-07 修过同一处，注释写着「引号污染导致 404」）——
 * 本处是三份复制实现之一，没跟上。取正则时**照抄那一份**，不要自己再写一遍。
 */
export function credsFallback(dshHome: string, config: Config): void {
  if (config.telegramBotToken && config.telegramChatId) return
  try {
    const cred = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')
    const t = cred.match(/^\s*TELEGRAM_BOT_TOKEN:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/m)
    const c = cred.match(/^\s*TELEGRAM_CHAT_ID:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/m)
    const tok = (t && (t[1] ?? t[2] ?? t[3])) ?? ''
    const chat = (c && (c[1] ?? c[2] ?? c[3])) ?? ''
    if (tok && !config.telegramBotToken) config.telegramBotToken = tok
    if (chat && !config.telegramChatId) config.telegramChatId = chat
  } catch { /* 无凭据文件即保持未配置——由 ready() 响亮报出 */ }
}

export function apply(ctx: Context, config: Config): void {
  // enabled 必须在 apply() 里被消费：显式 false 时挂载但不提供任何服务/副作用。
  // 只认 === false（未配置/undefined 视为启用），避免把「没写」误判成「关掉」（t-ef0af5ff）。
  if (config.enabled === false) return
  const logger = ctx.logger('agent-notify')

  const dshHome = process.env['DSH_HOME'] ?? join(process.env['USERPROFILE'] ?? process.cwd(), '.dsh')
  const tracePath = config.tracePath || join(dshHome, 'notify-trace.jsonl')
  credsFallback(dshHome, config)

  /** 追加一行留痕。吞错并返回 void（观测绝不反噬主流程）。
   *  2026-10-09 判别要点：双路径尝试——绝对路径失败时改试相对路径，
   *  使离线夹具（无 DSH_HOME、cwd 即临时目录）同样能落痕。 */
  const writeTrace = (row: Record<string, unknown>): void => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'
    for (const p of [tracePath, 'notify-trace.jsonl']) {
      try {
        mkdirSync(dirname(p), { recursive: true })
        appendFileSync(p, line, 'utf8')
        return
      } catch { /* 试下一路径 */ }
    }
    logger.warn('留痕写入失败（两条路径均不可写）：' + tracePath)
  }

  const ready = (): { ok: boolean; detail: string } => {
    if (config.dryRun) {
      return config.dryRunPath.trim().length > 0
        ? { ok: true, detail: 'dryRun 已开，落点=' + config.dryRunPath }
        : { ok: false, detail: 'dryRun 已开但 dryRunPath 为空——干跑也会失败' }
    }
    if (!config.telegramBotToken || !config.telegramChatId) {
      return { ok: false, detail: '未配置 telegramBotToken/telegramChatId（且 .credentials.yaml 无兜底）' }
    }
    return { ok: true, detail: 'Telegram 通道就绪（主 node-fetch + 兜底 curl）' }
  }

  const alert = async (input: AlertInput): Promise<NotifyResult> => {
    const nowMs = Date.now()
    const key = normalizeDedupKey(input?.dedupKey ?? '')
    const nowIso = new Date(nowMs).toISOString()
    try {
      const decision = decideSend({
        nowMs,
        dedupKey: key,
        lastSentAtMs: lastSent.atMs,
        lastDedupKey: lastSent.dedupKey,
        cooldownMs: config.cooldownMinutes * 60_000,
      })
      const text = composeAlertText(input, nowIso)
      if (!decision.send) {
        writeTrace({ stage: 'suppressed', dedupKey: key, reason: decision.reason })
        return { ok: true, channel: 'suppressed', detail: decision.reason, dedupKey: key, text }
      }
      const r: AlertTransportResult = await sendTelegramAlert({
        token: config.telegramBotToken,
        chatId: config.telegramChatId,
        text,
        proxy: config.proxy,
        timeoutMs: config.timeoutMs,
        dryRun: config.dryRun,
        dryRunPath: config.dryRunPath,
      })
      if (r.ok) lastSent.atMs = nowMs
      lastSent.dedupKey = key
      writeTrace({ stage: r.ok ? 'sent' : 'failed', channel: r.channel, dedupKey: key, detail: r.detail, reason: decision.reason, chars: text.length })
      if (!r.ok) logger.warn('出外告警失败：' + r.detail)
      else logger.info('出外告警已送出（' + r.channel + '，' + text.length + ' 字符）')
      return { ok: r.ok, channel: r.channel, detail: r.detail, dedupKey: key, text }
    } catch (err) {
      // I5：绝不冒泡——调用方多半是定时器，抛出去就是炸 web（§5.24）
      const detail = String(err)
      writeTrace({ stage: 'error', dedupKey: key, detail })
      logger.warn('出外告警异常（已吞）：' + detail)
      return { ok: false, channel: 'none', detail, dedupKey: key, text: '' }
    }
  }

  ctx.provide('notify', { alert, ready, name: 'agent-notify' } satisfies NotifyService)

  ctx.effect(() => {
    const r = ready()
    logger.info('ready: 出外告警通道已装配（' + r.detail + '）')
    // 自证（AGENTS.md §5.22 规则 1：关键机制不得只写 ctx.logger——本环境 web 进程 stdout
    // **没有落点文件**，只写 logger 等于写进虚空）。装配即落一行，使「通道到底装没装上、
    // 凭据解没解析出来」成为可 tail 的读数，而不是要我靠推断。
    writeTrace({ stage: 'ready', ok: r.ok, detail: r.detail, dryRun: config.dryRun })
    return () => { /* 无定时器、无监听器需要清理（I2：不自动重试、不自动行动） */ }
  })
}
