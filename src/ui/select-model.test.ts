/**
 * 自定义下拉交互模型测试（node:test，零依赖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  edgeActiveIndex, firstEnabledIndex, initialActiveIndex, lastEnabledIndex,
  selectDisplayLabel, selectedOption, stepActiveIndex, type SelectOption,
} from './select-model.ts'

const OPTS: SelectOption[] = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B', disabled: true },
  { value: 'c', label: 'C' },
]

test('selectedOption / selectDisplayLabel：命中、未命中与回退链', () => {
  assert.equal(selectedOption(OPTS, 'c')?.label, 'C')
  assert.equal(selectedOption(OPTS, 'zzz'), undefined)
  assert.equal(selectDisplayLabel(OPTS, 'a'), 'A')
  // 未命中：先用 fallback（调用点的占位文案），没有再退回原值（绝不显示空白）
  assert.equal(selectDisplayLabel(OPTS, 'zzz', '（已失效）'), '（已失效）')
  assert.equal(selectDisplayLabel(OPTS, 'zzz'), 'zzz')
})

test('initialActiveIndex：选中项优先，选中项不可用则落到第一个可用项', () => {
  assert.equal(initialActiveIndex(OPTS, 'c'), 2)
  // 选中项被禁用 → 不把高亮停在禁用项上
  assert.equal(initialActiveIndex(OPTS, 'b'), 0)
  assert.equal(initialActiveIndex(OPTS, 'nope'), 0)
  assert.equal(initialActiveIndex([], 'a'), -1)
})

test('firstEnabledIndex / lastEnabledIndex：跳过禁用项', () => {
  assert.equal(firstEnabledIndex(OPTS), 0)
  assert.equal(lastEnabledIndex(OPTS), 2)
  assert.equal(firstEnabledIndex([{ value: 'x', label: 'X', disabled: true }]), -1)
  assert.equal(lastEnabledIndex([{ value: 'x', label: 'X', disabled: true }]), -1)
  assert.equal(firstEnabledIndex([]), -1)
})

test('stepActiveIndex：禁用项跳过 + 环绕 + 无高亮时落到首/尾', () => {
  // 0 → 跳过被禁用的 1 → 2
  assert.equal(stepActiveIndex(OPTS, 0, 1), 2)
  // 2 → 环绕回 0（中间禁用项跳过）
  assert.equal(stepActiveIndex(OPTS, 2, 1), 0)
  // 0 → 反向环绕 → 2
  assert.equal(stepActiveIndex(OPTS, 0, -1), 2)
  // 无高亮（-1）：正向 → 首项，反向 → 尾项
  assert.equal(stepActiveIndex(OPTS, -1, 1), 0)
  assert.equal(stepActiveIndex(OPTS, -1, -1), 2)
})

test('stepActiveIndex：全部禁用 / 空清单恒 -1；单项时原地返回', () => {
  const allDisabled: SelectOption[] = [
    { value: 'a', label: 'A', disabled: true },
    { value: 'b', label: 'B', disabled: true },
  ]
  assert.equal(stepActiveIndex(allDisabled, 0, 1), -1)
  assert.equal(stepActiveIndex([], -1, 1), -1)
  const single: SelectOption[] = [{ value: 'only', label: 'Only' }]
  assert.equal(stepActiveIndex(single, 0, 1), 0)
  assert.equal(stepActiveIndex(single, 0, -1), 0)
})

test('edgeActiveIndex：Home/End 跳过禁用项', () => {
  assert.equal(edgeActiveIndex(OPTS, 'first'), 0)
  assert.equal(edgeActiveIndex(OPTS, 'last'), 2)
  const tailDisabled: SelectOption[] = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B', disabled: true },
  ]
  assert.equal(edgeActiveIndex(tailDisabled, 'last'), 0)
})
