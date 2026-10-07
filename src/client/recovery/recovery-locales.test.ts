/**
 * A1c 文案级守卫：`sessions.desc`（面板「会话体检」卡片的说明）必须与面板真实能力同口径。
 *
 * 钉住三件事（口径来自 captain 的逐句核证）：
 *  ① 四档严重级都要点到 —— 旧文案漏了最严重的一档「会让 DSH 起不来」；
 *  ② 应用内可修是**两类**且要写清边界：零损失（重放重复行 / 可证明的合成收尾块）与
 *     有损（序列空洞 / 不可解析行，需逐条显式确认、不批量）—— 旧文案只提了「重放重复行」；
 *  ③ 「其余类别」的真实出路必须分类：布局归位 / 重复 id 隔离 → 离线 `dcm sessions repair --fix` 真会执行；
 *     容器或首帧读不出来 / 格式超前 / 未登记工作区 / 子代理缺父 → **本工具不修**（离线 CLI 也修不了）。
 *     旧的「其余损坏类别仍只能走离线 CLI」把「修不了」说成「有命令可修」，必须绝迹。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { en, zh } from './recovery-locales.ts'

/** 旧句特征（zh / en）：出现即红 —— 同一不实表述的两种语言形态。 */
const LEGACY_CLAIMS: ReadonlyArray<RegExp> = [
  /仍只能走离线 CLI/,
  /只能走离线 CLI/,
  /still need the offline CLI/i,
  /only (?:via|through) the offline CLI/i,
  /the offline CLI is the only (?:way|option)/i,
]

test('A1c：sessions.desc 不再把「修不了」说成「只能走离线 CLI」', () => {
  const zhText: string = zh['sessions.desc']
  const enText: string = en['sessions.desc']
  assert.ok(zhText.length > 0, 'zh 键必须存在且非空')
  assert.ok(enText.length > 0, 'en 键必须存在且非空')
  for (const re of LEGACY_CLAIMS) {
    assert.doesNotMatch(zhText, re, 'zh 不得再出现旧说法：' + String(re))
    assert.doesNotMatch(enText, re, 'en 不得再出现旧说法：' + String(re))
  }
})

test('A1c：sessions.desc 补齐四档严重级 + 两类应用内修复能力（含预览/备份/回滚承诺）', () => {
  const zhText: string = zh['sessions.desc']
  const enText: string = en['sessions.desc']
  // ① 四档严重级（含最严重的一档 —— 旧文案漏的就是它）
  for (const token of ['会让 DSH 起不来', '读不出来', '下次请求会失败', '看不见']) {
    assert.ok(zhText.includes(token), 'zh 说明必须点到严重级：' + token)
  }
  for (const token of ['block DSH startup', 'cannot load', 'next request fails', 'invisible']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 说明必须点到严重级：' + token)
  }
  // ② 两类应用内能力边界
  for (const token of ['零损失', '重放重复行', '合成收尾块', '有损', '序列空洞', '不可解析行', '逐条', '不批量']) {
    assert.ok(zhText.includes(token), 'zh 必须写清能力边界：' + token)
  }
  for (const token of ['lossless', 'replayed duplicate rows', 'synthetic closer', 'lossy', 'seq gaps', 'unparsable', 'explicitly']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 必须写清能力边界：' + token)
  }
  // 仍然保留「先预览 / 自动备份 / 可回滚」的承诺（旧文案里成立的那一半不能丢）
  assert.ok(zhText.includes('预览') && zhText.includes('备份') && zhText.includes('可回滚'), 'zh 必须保留预览/备份/可回滚承诺')
  assert.ok(enText.includes('preview') && enText.includes('backup') && enText.includes('rollback'), 'en 必须保留预览/备份/可回滚承诺')
})

test('A1c：sessions.desc 把「其余类别」的两条真实出路分类写清', () => {
  const zhText: string = zh['sessions.desc']
  const enText: string = en['sessions.desc']
  // (i) 离线 CLI **真会改**的那两类（点名到命令）
  for (const token of ['布局归位', '重复 id 隔离', 'dcm sessions repair --fix']) {
    assert.ok(zhText.includes(token), 'zh 必须点出离线可执行的类别与命令：' + token)
  }
  for (const token of ['layout relocation', 'duplicate-id quarantine', 'dcm sessions repair --fix']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 必须点出离线可执行的类别与命令：' + token)
  }
  // (ii) 本工具**不修**的那几类（如实说「修不了」，不得再暗示有命令可修）
  for (const token of ['本工具不修', '容器', '首帧读不出来', '格式超前', '未登记工作区', '子代理缺父']) {
    assert.ok(zhText.includes(token), 'zh 必须如实写清修不了的类别：' + token)
  }
  for (const token of ['does not repair', 'container', 'future formats', 'unregistered workspaces', 'without a parent']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 必须如实写清修不了的类别：' + token)
  }
})
