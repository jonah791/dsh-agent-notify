/**
 * notify.test.mjs — 出外告警通道的判据测试
 *
 * 分三层：
 *   ① 纯决策层（`decideSend` / `normalizeDedupKey` / `composeAlertText`）——含**尸体样本**
 *   ② 传输判据（`judgeTelegramResponse`）——含 2026-09-11 实测过的**误报形态**（exit 0 但 API ok=false）
 *   ③ 壳层集成（`apply` + 假 Context + dryRun 落点）——证明「判定触发 → 载荷被组装 → 落盘可见」
 *
 * ⚠ 天花板（诚实标注）：本文件**不能**证明 Telegram 通道可用——那需要真网络与真凭据。
 * 通道可用性的证据来自它的前身（同一实现在 sentinel/watch 里已生产送达过）。
 * 本文件证明的是：判据有区分力、拒绝路径响亮、载荷组装正确。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decideSend, normalizeDedupKey, composeAlertText } from '../lib/notify.js'
import { judgeTelegramResponse } from '../lib/transport.js'
import { apply } from '../lib/index.js'

const MIN = 60_000

// ---------- ① 纯决策层 ----------

test('normalizeDedupKey：裁剪 / 小写 / 折叠空白', () => {
  assert.equal(normalizeDedupKey('  Absence   ALERT '), 'absence alert')
})

test('normalizeDedupKey：空串归为 unnamed（不许静默无键）', () => {
  assert.equal(normalizeDedupKey(''), 'unnamed')
  assert.equal(normalizeDedupKey('   '), 'unnamed')
  assert.equal(normalizeDedupKey(undefined), 'unnamed')
})

test('decideSend：首次（无历史）→ 发', () => {
  const d = decideSend({ nowMs: 1000 * MIN, dedupKey: 'k', lastSentAtMs: 0, lastDedupKey: '', cooldownMs: 30 * MIN })
  assert.equal(d.send, true)
  assert.match(d.reason, /首次/)
})

test('decideSend：同键冷却中 → 抑制，且理由报出剩余分钟', () => {
  const d = decideSend({ nowMs: 10 * MIN, dedupKey: 'k', lastSentAtMs: 0 === 0 ? 1 * MIN : 0, lastDedupKey: 'k', cooldownMs: 30 * MIN })
  assert.equal(d.send, false)
  assert.match(d.reason, /冷却中/)
  assert.match(d.reason, /还剩 21 分钟/)
})

test('decideSend：同键冷却已过 → 发', () => {
  const d = decideSend({ nowMs: 40 * MIN, dedupKey: 'k', lastSentAtMs: 1 * MIN, lastDedupKey: 'k', cooldownMs: 30 * MIN })
  assert.equal(d.send, true)
  assert.match(d.reason, /冷却已过/)
})

test('decideSend：换了去重键 → 发（新故障不被冷却挡住）', () => {
  const d = decideSend({ nowMs: 2 * MIN, dedupKey: 'new', lastSentAtMs: 1 * MIN, lastDedupKey: 'old', cooldownMs: 30 * MIN })
  assert.equal(d.send, true)
  assert.match(d.reason, /去重键变化/)
})

// 尸体样本 1：冷却窗口非法（0 / 负数 / NaN）必须**拒绝发送**，而不是退化成「每次必发」
// —— 否则一个写错的配置会变成对主人的刷屏器（§5.12 防刷屏）。
test('尸体：cooldownMs=0 / 负数 / NaN → 拒绝发送（不退化为每次必发）', () => {
  for (const bad of [0, -1, Number.NaN]) {
    const d = decideSend({ nowMs: 10 * MIN, dedupKey: 'k', lastSentAtMs: 1 * MIN, lastDedupKey: 'k', cooldownMs: bad })
    assert.equal(d.send, false, 'cooldownMs=' + String(bad) + ' 竟放行')
    assert.match(d.reason, /冷却窗口非法/)
  }
})

// 尸体样本 2：判定时刻非法 → 拒绝发送
test('尸体：nowMs=NaN → 拒绝发送', () => {
  const d = decideSend({ nowMs: Number.NaN, dedupKey: 'k', lastSentAtMs: 0, lastDedupKey: '', cooldownMs: 30 * MIN })
  assert.equal(d.send, false, 'NaN 时刻竟放行')
  assert.match(d.reason, /时刻非法/)
})

test('composeAlertText：标题 + 每行前缀 + as-of 页脚；空行被剔除', () => {
  const t = composeAlertText({ title: '⚠ 测试告警', lines: ['行一', '  ', '行二'], dedupKey: 'k' }, '2026-10-09T06:00:00.000Z')
  assert.equal(t, '⚠ 测试告警\n· 行一\n· 行二\n（as-of 2026-10-09T06:00:00.000Z）')
})

test('composeAlertText：空标题不留白（有兜底文案，不是空串）', () => {
  const t = composeAlertText({ title: '   ', lines: [], dedupKey: 'k' }, '2026-10-09T06:00:00.000Z')
  assert.match(t, /无标题告警/)
})

// ---------- ② 传输判据 ----------

test('judgeTelegramResponse：exit 0 且 ok=true → 送达', () => {
  assert.equal(judgeTelegramResponse(0, '{"ok":true,"result":{}}').ok, true)
})

// 尸体样本 3：**2026-09-11 实测过的误报形态** —— 子进程 exit 0，但 API 返回 ok=false。
// 只看退出码会把「API 拒绝」读成「已送达」，告警静默丢失。判据必须两个条件都验。
test('尸体：exit 0 但 API ok=false → 判失败（只看退出码会误报送达）', () => {
  const r = judgeTelegramResponse(0, '{"ok":false,"description":"chat not found"}')
  assert.equal(r.ok, false, 'API 拒绝竟被判为送达')
  assert.match(r.detail, /API 拒绝/)
})

test('尸体：子进程报 ERR → 判失败', () => {
  assert.equal(judgeTelegramResponse(null, 'ERR Error: timeout').ok, false)
})

test('尸体：响应非 JSON → 判失败', () => {
  assert.equal(judgeTelegramResponse(0, '<html>502</html>').ok, false)
})

test('尸体：exit 非 0 → 判失败（即便响应体是 ok=true）', () => {
  assert.equal(judgeTelegramResponse(2, '{"ok":true}').ok, false)
})

// ---------- ③ 壳层集成（假 Context + dryRun） ----------

function makeCtx() {
  const provided = new Map()
  const logs = []
  const ctx = {
    logger: () => ({ info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), debug: () => {} }),
    provide: (n, s) => provided.set(n, s),
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  }
  return { ctx, provided, logs }
}

function makeConfig(dir, extra = {}) {
  return {
    enabled: true,
    telegramBotToken: '',
    telegramChatId: '',
    proxy: 'http://127.0.0.1:16888',
    timeoutMs: 15000,
    cooldownMinutes: 30,
    dryRun: true,
    dryRunPath: join(dir, 'dryrun.jsonl'),
    tracePath: join(dir, 'notify-trace.jsonl'),
    ...extra,
  }
}

test('壳层：apply 注册 notify 服务，且提供 alert / ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const { ctx, provided } = makeCtx()
  apply(ctx, makeConfig(dir))
  const svc = provided.get('notify')
  assert.ok(svc, '未 provide notify 服务')
  assert.equal(typeof svc.alert, 'function')
  assert.equal(typeof svc.ready, 'function')
  assert.equal(svc.name, 'agent-notify')
})

test('壳层 drayRun 端到端：首次写入落点 → 同键第二次被冷却抑制 → 落点仍只有 1 行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const cfg = makeConfig(dir)
  const { ctx, provided } = makeCtx()
  apply(ctx, cfg)
  const svc = provided.get('notify')

  const r1 = await svc.alert({ title: '⚠ 测试：我不在场', lines: ['距上次在场 200 分钟'], dedupKey: 'absence' })
  assert.equal(r1.ok, true, r1.detail)
  assert.equal(r1.channel, 'dry-run')

  const r2 = await svc.alert({ title: '⚠ 测试：我不在场', lines: ['距上次在场 201 分钟'], dedupKey: 'absence' })
  assert.equal(r2.channel, 'suppressed', '同键第二次竟重复投递：' + r2.detail)

  const lines = readFileSync(cfg.dryRunPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, '冷却失效：落点有 ' + lines.length + ' 行')
  const payload = JSON.parse(lines[0])
  assert.match(payload.text, /我不在场/)
  assert.match(payload.text, /200 分钟/)
})

test('壳层：换键可绕过冷却（新故障立刻可见）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const cfg = makeConfig(dir)
  const { ctx, provided } = makeCtx()
  apply(ctx, cfg)
  const svc = provided.get('notify')
  await svc.alert({ title: 'A', lines: ['x'], dedupKey: 'key-a' })
  const r = await svc.alert({ title: 'B', lines: ['y'], dedupKey: 'key-b' })
  assert.equal(r.ok, true)
  assert.equal(r.channel, 'dry-run')
  assert.equal(readFileSync(cfg.dryRunPath, 'utf8').trim().split('\n').length, 2)
})

// 尸体样本 4：dryRun 开着但落点为空 ⇒ 必须**响亮失败**，不许静默丢弃（观测绝不空吞）
test('尸体：dryRun 已开但 dryRunPath 为空 → ok:false（不静默丢弃）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const { ctx, provided } = makeCtx()
  apply(ctx, makeConfig(dir, { dryRunPath: '' }))
  const svc = provided.get('notify')
  assert.equal(svc.ready().ok, false)
  const r = await svc.alert({ title: 'x', lines: [], dedupKey: 'k' })
  assert.equal(r.ok, false, '空落点竟报成功')
  assert.match(r.detail, /dryRunPath/)
})

// 尸体样本 5：非干跑且无凭据 ⇒ 失败响亮，且**不许**假称送达
test('尸体：非干跑 + 无凭据 → 失败响亮（不得假称送达）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const { ctx, provided } = makeCtx()
  process.env.DSH_HOME = dir // 隔离：避免读到真机 .credentials.yaml
  apply(ctx, makeConfig(dir, { dryRun: false, telegramBotToken: '', telegramChatId: '' }))
  const svc = provided.get('notify')
  const r = await svc.alert({ title: 'x', lines: [], dedupKey: 'k-nocreds' })
  assert.equal(r.ok, false, '无凭据竟报成功')
  assert.equal(r.channel, 'none')
  assert.match(r.detail, /未配置/)
})

test('壳层：每次调用都留痕（含被抑制的那次）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const cfg = makeConfig(dir)
  const { ctx, provided } = makeCtx()
  apply(ctx, cfg)
  const svc = provided.get('notify')
  await svc.alert({ title: 'A', lines: ['x'], dedupKey: 'trace-key' })
  await svc.alert({ title: 'A', lines: ['x'], dedupKey: 'trace-key' })
  assert.ok(existsSync(cfg.tracePath), '留痕文件不存在')
  const rows = readFileSync(cfg.tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 3, '应有 ready + sent + suppressed 三行')
  assert.deepEqual(rows.map((r) => r.stage), ['ready', 'sent', 'suppressed'])
  // 装配自证行（§5.22 规则 1）必须**带结论**，不能只是一句「来了」——
  // 否则读数看不出「凭据到底解没解析出来」，自证就退化成又一个有心跳没健康的地方。
  assert.equal(typeof rows[0].ok, 'boolean')
  assert.ok(String(rows[0].detail).length > 0, 'ready 行未带 ready() 的结论')
})

// 尸体样本 6：enabled 显式 false ⇒ 不 provide 服务（挂载但不贡献）
test('尸体：enabled=false → 不提供 notify 服务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const { ctx, provided } = makeCtx()
  apply(ctx, makeConfig(dir, { enabled: false }))
  assert.equal(provided.has('notify'), false, 'enabled=false 仍提供了服务')
})

test('壳层：凭据可从 .credentials.yaml 兜底读出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  writeFileSync(join(dir, '.credentials.yaml'), 'TELEGRAM_BOT_TOKEN: 123:abc\nTELEGRAM_CHAT_ID: 456\n', 'utf8')
  process.env.DSH_HOME = dir
  const { ctx, provided } = makeCtx()
  apply(ctx, makeConfig(dir, { dryRun: false, telegramBotToken: '', telegramChatId: '' }))
  const svc = provided.get('notify')
  assert.equal(svc.ready().ok, true, '凭据兜底未生效：' + svc.ready().detail)
})
