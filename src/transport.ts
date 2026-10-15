/**
 * transport.ts — 出外告警的**传输层**（IO）
 *
 * 本文件是已在线跑通的告警传输的**规范化副本**：在 2026-10-09 之前，完全相同的 7783 B
 * 传输实现在 `dsh-agent-watch` / `dsh-agent-sentinel` / `dsh-agent-guardian` 里各存一份
 * （三份同样大小）。本插件把这份能力收成**一个可被程序调用的服务**，供任何插件调用——
 * 「我不在场」类告警的缺口正因为此前**没有任何插件能程序化地把话送出机器**。
 *
 * 通道选择的实测依据（沿用原注释，勿删——它是这条通道存在的理由）：
 * 本环境 curl 8.21.0 是 Schannel 版，经 clash 代理（127.0.0.1:16888）时 CONNECT 隧道建立成功
 * 但随后的 TLS 握手一律失败（`curl -x http://127.0.0.1:16888 https://api.telegram.org` → exit 35，
 * `-k` / `--http1.1` / `--tlsv1.2` 各变体同样 35）；而同一代理、同一时刻 Node 内置 fetch
 * （OpenSSL）成功。⇒ 主通道 = spawn node 子进程 + 注入 `NODE_USE_ENV_PROXY`（该变量只在
 * **进程启动时**被 EnvHttpProxyAgent 读取，进程内设置无效），curl 仅作兜底。
 *
 * 子进程输出写临时文件而非管道：Windows 沙箱下捕获管道 stdio 的 spawn 会 EPERM；
 * 写文件形态在沙箱内与生产环境同样可用。
 *
 * ⚠ 边界（天花板诚实）：`dryRun` 只能证明**判据会触发、载荷被组装**，不能证明 Telegram 通道可用。
 * 通道可用性的证据来自它的前身（sentinel/watch 的告警已在生产送达过）；本插件沿用同一实现。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

/** 告警发送结果（channel 用于证据链：走的是哪条通道）。 */
export interface AlertTransportResult {
  ok: boolean
  /** 实际尝试并得出结论的通道；none = 未发送（缺凭据或被拒） */
  channel: 'node-fetch' | 'curl' | 'dry-run' | 'none'
  /** 人类可读结论（含失败原因），供落盘证据使用 */
  detail: string
}

/** 发送参数。 */
export interface AlertTransportOptions {
  token: string
  chatId: string
  text: string
  /** curl 兜底通道使用的 http 代理（node-fetch 通道走 env 代理变量） */
  proxy?: string
  /** 单通道超时（ms） */
  timeoutMs?: number
  /** 干跑：不发送，把载荷追加到 dryRunPath（用于验收与调试，不占主人带宽） */
  dryRun?: boolean
  /** 干跑落点（dryRun 为 true 时必填，否则干跑本身也失败——不许静默吞掉） */
  dryRunPath?: string
}

/** 子进程内执行的取回脚本：POST JSON，把响应体写入文件。 */
const FETCH_SCRIPT = `
const [url, body, outPath] = process.argv.slice(1)
const fs = require('node:fs')
fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
  signal: AbortSignal.timeout(Number(process.env.ALERT_TIMEOUT_MS || 12000)),
}).then((r) => r.text())
  .then((t) => { fs.writeFileSync(outPath, t, 'utf8') })
  .catch((e) => { fs.writeFileSync(outPath, 'ERR ' + String(e), 'utf8'); process.exit(2) })
`

/**
 * 判定一次 Telegram API 回复是否真的送达（纯函数，可离线单测）。
 * 判据 = 子进程退出码 0 **且** 响应体 `ok === true`；只满足其一都算失败
 * （实测存在「exit 0 但 API 返回 ok=false」的形态，单看退出码会误报已送达）。
 * @param code - 子进程退出码（null = 未正常退出）
 * @param stdout - 响应体原文
 * @returns 是否送达与原因
 */
export function judgeTelegramResponse(code: number | null, stdout: string): { ok: boolean; detail: string } {
  if (stdout.startsWith('ERR ')) return { ok: false, detail: stdout.slice(0, 200) }
  let parsed: { ok?: boolean; description?: string } | null = null
  try {
    parsed = JSON.parse(stdout) as { ok?: boolean; description?: string }
  } catch {
    return { ok: false, detail: '响应非 JSON（exit=' + String(code) + '）：' + stdout.slice(0, 150) }
  }
  if (code !== 0) return { ok: false, detail: 'exit=' + String(code) + ' 响应=' + stdout.slice(0, 150) }
  if (parsed.ok !== true) return { ok: false, detail: 'API 拒绝：' + (parsed.description ?? stdout.slice(0, 150)) }
  return { ok: true, detail: 'ok' }
}

/** 主通道：spawn node 子进程（注入 NODE_USE_ENV_PROXY）执行 fetch。 */
function sendViaNodeFetch(url: string, body: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const outPath = join(tmpdir(), 'dsh-notify-' + process.pid + '-' + Date.now() + '.json')
    const child = spawn(process.execPath, ['-e', FETCH_SCRIPT, url, body, outPath], {
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', ALERT_TIMEOUT_MS: String(timeoutMs) },
      windowsHide: true,
      stdio: 'ignore',
    })
    const finish = (code: number | null): void => {
      let out = ''
      try {
        if (existsSync(outPath)) out = readFileSync(outPath, 'utf8')
      } catch { /* 读失败即无响应体，由判据报失败 */ }
      try {
        if (existsSync(outPath)) unlinkSync(outPath)
      } catch { /* 临时文件清理失败无害 */ }
      resolve({ code, out })
    }
    child.on('error', (e) => resolve({ code: null, out: 'ERR spawn ' + String(e) }))
    child.on('close', (code) => finish(code))
  })
}

/** 兜底通道：curl.exe + 显式代理（保留原行为，仅在主通道失败后尝试）。 */
function sendViaCurl(url: string, body: string, proxy: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const outPath = join(tmpdir(), 'dsh-notify-curl-' + process.pid + '-' + Date.now() + '.json')
    const child = spawn('curl.exe', [
      '-s', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-x', proxy,
      '-H', 'Content-Type: application/json',
      '-d', body,
      '-o', outPath,
      url,
    ], { windowsHide: true, stdio: 'ignore' })
    const finish = (code: number | null): void => {
      let out = ''
      try {
        if (existsSync(outPath)) out = readFileSync(outPath, 'utf8')
      } catch { /* 同主通道 */ }
      try {
        if (existsSync(outPath)) unlinkSync(outPath)
      } catch { /* 同主通道 */ }
      resolve({ code, out })
    }
    child.on('error', (e) => resolve({ code: null, out: 'ERR spawn ' + String(e) }))
    child.on('close', (code) => finish(code))
  })
}

/** 干跑落点：把载荷原样追加到文件（验收时用，不占主人带宽）。 */
function dryRunWrite(path: string, payload: Record<string, unknown>): AlertTransportResult {
  if (!path || path.trim().length === 0) {
    return { ok: false, channel: 'none', detail: 'dryRun 已开但 dryRunPath 未配置——拒绝静默丢弃' }
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(payload) + '\n', 'utf8')
    return { ok: true, channel: 'dry-run', detail: '已写入 ' + path }
  } catch (err) {
    return { ok: false, channel: 'none', detail: '干跑落盘失败：' + String(err) }
  }
}

/**
 * 发送告警：主通道 node-fetch → 失败则 curl 兜底；每次调用返回可落盘的结论。
 * @param opts - 发送参数
 * @returns 是否送达、所用通道、结论详情
 */
export async function sendTelegramAlert(opts: AlertTransportOptions): Promise<AlertTransportResult> {
  const { token, chatId, text } = opts
  if (opts.dryRun === true) {
    return dryRunWrite(opts.dryRunPath ?? '', { dryRun: true, chatId, text, at: new Date().toISOString() })
  }
  if (!token || !chatId) {
    return { ok: false, channel: 'none', detail: '未配置 telegramBotToken/telegramChatId（告警通道不可用）' }
  }
  const timeoutMs = opts.timeoutMs ?? 15000
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage'
  const body = JSON.stringify({ chat_id: Number(chatId), text, disable_notification: false })

  const primary = await sendViaNodeFetch(url, body, timeoutMs)
  const primaryJudge = judgeTelegramResponse(primary.code, primary.out)
  if (primaryJudge.ok) return { ok: true, channel: 'node-fetch', detail: 'node-fetch 送达' }

  const proxy = opts.proxy || 'http://127.0.0.1:16888'
  const fallback = await sendViaCurl(url, body, proxy, timeoutMs)
  const fallbackJudge = judgeTelegramResponse(fallback.code, fallback.out)
  if (fallbackJudge.ok) return { ok: true, channel: 'curl', detail: 'curl 兜底送达（主通道失败：' + primaryJudge.detail + '）' }

  return {
    ok: false,
    channel: 'curl',
    detail: '双通道均失败：node-fetch[' + primaryJudge.detail + '] curl[' + fallbackJudge.detail + ']',
  }
}
