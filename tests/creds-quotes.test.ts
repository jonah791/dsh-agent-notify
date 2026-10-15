/**
 * 凭据读取的引号清洗 —— 尸体测试。
 *
 * 为什么需要它（2026-10-11 实测）：本插件的 `credsFallback` 原来用 `(\S+)` 取值，
 * 而真实的 `.credentials.yaml` 里值**带双引号**（`TELEGRAM_BOT_TOKEN: "123:abc"`）
 * ⇒ 引号被吃进 token ⇒ Telegram API 返 **404 Not Found**（不是 401，极易误读成「接口不对」）。
 * 实测代价：庄园存活巡检的告警**从未真正出过机器**。
 *
 * ⚠ 原有的 37 个测试**盖不住它**——它们的夹具写的是 `TELEGRAM_BOT_TOKEN: 123:abc`（**无引号**）。
 * 「夹具验证不了你的理解」在这里的具体形态就是：**夹具的形态比真实语料更干净**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { credsFallback } from '../src/index.ts'

function fixture(credText: string): { dir: string; config: any } {
  const dir = mkdtempSync(join(tmpdir(), 'notify-creds-'))
  writeFileSync(join(dir, '.credentials.yaml'), credText, 'utf8')
  return { dir, config: { telegramBotToken: '', telegramChatId: '' } }
}

test('尸体①：值带双引号 ⇒ 必须清洗（这正是 404 的根因）', () => {
  const { dir, config } = fixture('TELEGRAM_BOT_TOKEN: "123456:ABC-DEF"\nTELEGRAM_CHAT_ID: "8790460537"\n')
  credsFallback(dir, config)
  assert.equal(config.telegramBotToken, '123456:ABC-DEF', '引号不得进入 token')
  assert.equal(config.telegramChatId, '8790460537', '引号不得进入 chat id')
})

test('尸体②：单引号同样清洗', () => {
  const { dir, config } = fixture("TELEGRAM_BOT_TOKEN: '123456:ABC-DEF'\nTELEGRAM_CHAT_ID: '8790460537'\n")
  credsFallback(dir, config)
  assert.equal(config.telegramBotToken, '123456:ABC-DEF')
  assert.equal(config.telegramChatId, '8790460537')
})

test('对照组：无引号（旧夹具的形态）仍须正确——修引号不得弄坏无引号的情形', () => {
  const { dir, config } = fixture('TELEGRAM_BOT_TOKEN: 123456:ABC-DEF\nTELEGRAM_CHAT_ID: 8790460537\n')
  credsFallback(dir, config)
  assert.equal(config.telegramBotToken, '123456:ABC-DEF')
  assert.equal(config.telegramChatId, '8790460537')
})

test('单一来源优先级：config 已有值时不被文件覆盖', () => {
  const { dir, config } = fixture('TELEGRAM_BOT_TOKEN: "from-file"\nTELEGRAM_CHAT_ID: "111"\n')
  config.telegramBotToken = 'from-config'
  config.telegramChatId = '222'
  credsFallback(dir, config)
  assert.equal(config.telegramBotToken, 'from-config')
  assert.equal(config.telegramChatId, '222')
})

test('尸体③：凭据文件不存在 ⇒ 不抛、保持未配置（由 ready() 响亮报出，不在这里静默）', () => {
  const config: any = { telegramBotToken: '', telegramChatId: '' }
  assert.doesNotThrow(() => credsFallback(join(tmpdir(), 'definitely-not-here-' + Date.now()), config))
  assert.equal(config.telegramBotToken, '')
  assert.equal(config.telegramChatId, '')
})
