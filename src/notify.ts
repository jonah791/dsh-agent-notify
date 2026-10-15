/**
 * notify.ts — 出外告警的**纯决策层**（无 IO，可离线单测与尸体测试）
 *
 * 本层只回答两个问题：
 *   ① 「这条告警现在要不要发」（去重 + 冷却）
 *   ② 「发出去长什么样」（排版）
 *
 * ⚠ 边界（AGENTS.md §2.1 机制送信号、决策归我）：本层**不决定告警的内容，也不决定
 * 何时该告警**——`title` / `lines` 由调用方给出，「我是否长时间不在场」由调用方判据判定。
 * 本插件只是一个**通道**：把调用方已经决定要说的话，送到机器外面去。
 */

/** 一次告警的内容（由调用方撰写，本插件不改写、不补全）。 */
export interface AlertInput {
  /** 一句话标题（调用方给，如「⚠ 感知圈停摆」） */
  title: string
  /** 正文行（调用方给，每行一条事实，含读数） */
  lines: string[]
  /** 去重键：同键在冷却窗口内只发一次；不同键可绕过冷却（新故障应当立刻可见） */
  dedupKey: string
}

/** 发送判定的输入（全部为显式观测值，无隐含状态）。 */
export interface SendDecisionInput {
  /** 判定时刻（ms） */
  nowMs: number
  /** 本次告警的去重键 */
  dedupKey: string
  /** 上次**实际发出**的时刻（ms；0 = 从未发过） */
  lastSentAtMs: number
  /** 上次实际发出的去重键（空串 = 无） */
  lastDedupKey: string
  /** 冷却窗口（ms） */
  cooldownMs: number
}

/** 发送判定结果（reason 一律非空——拒绝也要说得出理由）。 */
export interface SendDecision {
  send: boolean
  reason: string
}

/** 去重键的规范化：裁剪、小写、空白折叠；空串归为 `unnamed`（不许静默无键）。 */
export function normalizeDedupKey(raw: string): string {
  const t = (raw ?? '').trim().toLowerCase().replace(/\s+/gu, ' ')
  return t.length === 0 ? 'unnamed' : t
}

/**
 * 判定这条告警要不要发。
 *
 * 规则（顺序即优先级）：
 *   ① 从未发过 → 发（首次）
 *   ② 去重键与上次不同 → 发（换了故障说明情况变了，冷却不该挡住新事实）
 *   ③ 同键且已过冷却 → 发（持续故障的定期复述）
 *   ④ 同键且在冷却内 → 抑制（返回剩余分钟数，便于事后核对为什么没响）
 * @param input - 判定输入
 * @returns 是否发送与理由
 */
export function decideSend(input: SendDecisionInput): SendDecision {
  const key = normalizeDedupKey(input.dedupKey)
  if (!Number.isFinite(input.nowMs)) return { send: false, reason: '判定时刻非法（nowMs 非有限数）' }
  if (!(input.cooldownMs > 0)) return { send: false, reason: '冷却窗口非法（cooldownMs=' + String(input.cooldownMs) + '）——拒绝发送而不是退化为每次必发' }
  if (input.lastSentAtMs === 0) return { send: true, reason: '首次告警（无历史发送记录）' }
  if (key !== normalizeDedupKey(input.lastDedupKey)) {
    return { send: true, reason: '去重键变化（' + normalizeDedupKey(input.lastDedupKey) + ' → ' + key + '）——新故障不受冷却约束' }
  }
  const elapsed = input.nowMs - input.lastSentAtMs
  if (elapsed >= input.cooldownMs) {
    return { send: true, reason: '同键但冷却已过（距上次 ' + Math.round(elapsed / 60_000) + ' 分钟 ≥ ' + Math.round(input.cooldownMs / 60_000) + ' 分钟）' }
  }
  const remain = Math.ceil((input.cooldownMs - elapsed) / 60_000)
  return { send: false, reason: '同键冷却中（还剩 ' + remain + ' 分钟，键=' + key + '）' }
}

/**
 * 排版一条告警文本。
 * @param input - 告警内容
 * @param nowIso - 发送时刻（ISO，由调用方注入以便离线测试确定性）
 * @returns 可直接投递的纯文本
 */
export function composeAlertText(input: AlertInput, nowIso: string): string {
  const head = (input.title ?? '').trim() || '（无标题告警）'
  const body = (input.lines ?? []).map((l) => String(l)).filter((l) => l.trim().length > 0)
  return [head, ...body.map((l) => '· ' + l), '（as-of ' + nowIso + '）'].join('\n')
}
