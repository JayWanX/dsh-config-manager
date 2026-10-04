/**
 * 产物库视图模型的单测。重点不是「有没有返回行」，而是四条容易悄悄退化的口径：
 *  ① 动作由 capabilities 分派（远端删除只动远端那一份、市场不能恢复、快照没有下载）；
 *  ② 未知值不编造（缺体积 = undefined、缺时间排最后、缺通道段不渲染、缺作者不占位）；
 *  ③ 体积合计只在**全部都有体积**时给数字（否则 null —— 绝不把「未知」当 0 加进去）；
 *  ④ 搜索是分词 AND（「dsh zip」两个词都要命中），且覆盖文件名 / 备注 / id / 名称。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  artifactSortKey, countByKind, filterArtifacts, librarySummary, remoteSnapshotFileName, toArtifactRows,
  ARTIFACT_BADGE_LABEL_KEY, ARTIFACT_CAPABILITY_LABEL_KEY, ARTIFACT_KIND_LABEL_KEY,
  type ArtifactInput,
} from './artifact-view.ts'
import { makeUiT } from './i18n.ts'

const zh = makeUiT('zh')
const en = makeUiT('en')

function input(patch: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    snapshots: [{ id: 'snap-1', createdAt: '2026-10-01T20:36:00.000Z', entryCount: 1204, beforePluginCount: 42, pinned: true }],
    backupFiles: [
      { path: '/h/backups/a.zip', name: 'dsh-config-a.zip', sizeBytes: 38_400, mtimeMs: Date.parse('2026-09-30T10:00:00.000Z'), source: 'auto' },
      { path: '/h/backups/b.zip', name: 'dsh-config-b.zip', sizeBytes: 12_600_000, mtimeMs: Date.parse('2026-10-02T09:00:00.000Z'), source: 'manual', note: '改备注前的手动包', containerType: 'encrypted' },
    ],
    remoteSnapshots: [{ id: 'r-9', createdAt: '2026-09-28T17:03:00.000Z', sectionCount: 12, platform: 'win32', dshVersion: '0.2.0' }],
    remoteCurrentId: 'r-9',
    remoteChannel: 'git',
    marketItems: [{ id: 'm-1', name: '某配置', author: '张三', version: '1.2.0' }],
    ...patch,
  }
}

const rows = (patch: Partial<ArtifactInput> = {}, t = zh) => toArtifactRows(input(patch), t)
const byKey = (patch: Partial<ArtifactInput> = {}) => new Map(rows(patch).map((r) => [r.key, r]))

test('四源各成一行：key 唯一、kind/title 正确', () => {
  const all = rows()
  assert.equal(all.length, 5, '1 快照 + 2 备份文件 + 1 远端 + 1 市场')
  assert.equal(new Set(all.map((r) => r.key)).size, 5, 'key 必须唯一')
  assert.deepEqual(all.map((r) => r.kind).sort(), ['backup-file', 'backup-file', 'market', 'remote-snapshot', 'snapshot'])
  const s = byKey().get('snapshot:snap-1')
  assert.deepEqual(s?.title, { kind: 'time', iso: '2026-10-01T20:36:00.000Z' }, '快照主标识 = 时间标签（不在模型里格式化）')
  const f = byKey().get('backup-file:/h/backups/a.zip')
  assert.deepEqual(f?.title, { kind: 'text', value: 'dsh-config-a.zip' })
})

test('默认时间倒序；缺时间的排最后（不当「最早」）', () => {
  const all = rows({ marketItems: [{ id: 'm-x', name: '无时间条目' }] })
  const ats = all.map((r) => r.at)
  assert.equal(ats.at(-1), null, '缺时间的必须排最后')
  const known = ats.filter((x): x is string => x !== null)
  assert.deepEqual(known, [...known].sort().reverse(), '其余严格按时间倒序')
})

test('排序稳定：同一时间戳按 key 收敛，不依赖输入顺序', () => {
  const a = rows({ snapshots: [{ id: 'z', createdAt: '2026-01-01T00:00:00.000Z', entryCount: 1, beforePluginCount: 0 }, { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', entryCount: 1, beforePluginCount: 0 }] }).map((r) => r.key)
  const b = rows({ snapshots: [{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', entryCount: 1, beforePluginCount: 0 }, { id: 'z', createdAt: '2026-01-01T00:00:00.000Z', entryCount: 1, beforePluginCount: 0 }] }).map((r) => r.key)
  assert.deepEqual(a, b)
})

test('动作由 capabilities 分派，不由 kind 分派', () => {
  const m = byKey()
  // 置顶已移除（2026-10-03 用户要求）：它只是个排序偏好，却占了「更多」里的一格
  assert.deepEqual(m.get('snapshot:snap-1')?.capabilities, ['restore', 'consult', 'delete'], '快照：恢复 / 咨询 / 删除（无置顶）')
  assert.deepEqual(m.get('backup-file:/h/backups/a.zip')?.capabilities, ['import', 'consult', 'inspect', 'download', 'delete'])
  // 2026-10-04 用户要求：远端快照的 ⋯ 菜单与备份文件**逐项对齐**（咨询 / 查看与对比 / 下载 / 删除）
  assert.deepEqual(
    m.get('remote-snapshot:r-9')?.capabilities,
    ['pull', 'consult', 'inspect', 'download', 'delete'],
    '远端：拉取为主操作；⋯ = 咨询 / 查看与对比 / 下载 / 删除（与备份文件同序）',
  )
  // 2026-10-04 用户要求：市场条目只留「安装」一个动作 —— 原「查看与对比」与它同入口（都是开市场流程），是重复项
  assert.deepEqual(m.get('market:m-1')?.capabilities, ['install'], '市场条目不能「恢复」，只能安装')
})

test('远端快照落地文件名：按创建时间生成，异常输入回退且绝不含路径分隔符', () => {
  assert.equal(remoteSnapshotFileName('2026-10-02T01:33:30.000Z', 'r-9'), 'dsh-config-remote-20261002-013330.zip')
  // 非 ISO / 空时间 → 回退到清洗后的快照 id（仍唯一、仍安全）
  assert.equal(remoteSnapshotFileName('', 'r-9'), 'dsh-config-remote-r-9.zip')
  assert.equal(remoteSnapshotFileName('2026-10-02', 'r-9'), 'dsh-config-remote-r-9.zip', '只有日期没有时间 → 不硬凑')
  // id 里的危险字符必须被清掉：这个名字会进宿主 path.join(dir, name)
  const dirty = remoteSnapshotFileName('', '../../etc/passwd')
  assert.equal(dirty, 'dsh-config-remote-....etcpasswd.zip', '只保留 [A-Za-z0-9._-]，路径分隔符被剔除')
  assert.ok(!dirty.includes('/') && !dirty.includes('\\'), '绝不允许路径分隔符进落地文件名')
  assert.equal(remoteSnapshotFileName('', ''), 'dsh-config-remote-snapshot.zip', '时间与 id 都拿不到 → 兜底名')
})

test('快照不因 pinned 改变能力集合（置顶已移除）', () => {
  // 置顶曾按 pinned 派生 'pin' / 'unpin' 两种能力；2026-10-03 用户要求移除该操作，
  // 于是能力集合**与 pinned 无关** —— 这条断言正是那个「无关」的钉子。
  // 注意用 find 而不是 [0]：input() 只覆盖传入的字段，其余来源仍在，[0] 会是时间最新的那一行
  const off = rows({ snapshots: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z', entryCount: 1, beforePluginCount: 0, pinned: false }] }).find((row) => row.kind === 'snapshot')
  const on = rows({ snapshots: [{ id: 's2', createdAt: '2026-01-01T00:00:00.000Z', entryCount: 1, beforePluginCount: 0, pinned: true }] }).find((row) => row.kind === 'snapshot')
  assert.deepEqual(off?.capabilities, ['restore', 'consult', 'delete'])
  assert.deepEqual(on?.capabilities, ['restore', 'consult', 'delete'], 'pinned=true 也不得再出现 pin/unpin')
  assert.deepEqual(off?.badges, [])
})

test('加密备份文件：打 encrypted 徽章，但动作仍是 import（解锁是导入的第一阶段）', () => {
  const f = byKey().get('backup-file:/h/backups/b.zip')
  assert.deepEqual(f?.badges, ['encrypted'])
  assert.equal(f?.capabilities[0], 'import', '主操作不变，只有文案换成「解锁后导入」')
})

test('当前基线徽章只在命中 lastSnapshotId 时出现', () => {
  assert.deepEqual(byKey().get('remote-snapshot:r-9')?.badges, ['current'])
  assert.deepEqual(byKey({ remoteCurrentId: 'other' }).get('remote-snapshot:r-9')?.badges, [])
  assert.deepEqual(byKey({ remoteCurrentId: null }).get('remote-snapshot:r-9')?.badges, [], '基线未知 → 不标')
})

test('远端通道未知时元数据不渲染通道段（不猜成 Git）', () => {
  const git = byKey().get('remote-snapshot:r-9')?.meta ?? []
  assert.equal(git[0], 'Git')
  assert.deepEqual(git.slice(1), ['12 分区', 'DSH 0.2.0'])
  const unknown = byKey({ remoteChannel: null }).get('remote-snapshot:r-9')?.meta ?? []
  assert.deepEqual(unknown, ['12 分区', 'DSH 0.2.0'], '第一段整个不出现，而不是留个空段')
  assert.equal(byKey({ remoteChannel: 'webdav' }).get('remote-snapshot:r-9')?.meta[0], 'WebDAV')
})

test('体积只有备份文件有；其余 undefined（渲染成「—」，绝不显示 0）', () => {
  assert.equal(byKey().get('backup-file:/h/backups/a.zip')?.sizeBytes, 38_400)
  assert.equal(byKey().get('snapshot:snap-1')?.sizeBytes, undefined)
  assert.equal(byKey().get('remote-snapshot:r-9')?.sizeBytes, undefined)
  assert.equal(byKey().get('market:m-1')?.sizeBytes, undefined)
})

test('市场条目缺作者/版本时元数据段为空（不编造、不占位）', () => {
  const m = byKey({ marketItems: [{ id: 'm-2', name: '裸条目' }] }).get('market:m-2')
  assert.deepEqual(m?.meta, [])
  assert.equal(m?.at, null)
})

test('展开态的完整元数据：时间是 ISO（本地化留给渲染层），空值行不出现', () => {
  const f = byKey().get('backup-file:/h/backups/a.zip')
  const noteRow = f?.detail.find((p) => p.label === '备注')
  assert.equal(noteRow, undefined, '没有备注 → 不渲染一个空值行')
  const modified = f?.detail.find((p) => p.label === '修改时间')
  assert.equal(modified?.iso, '2026-09-30T10:00:00.000Z', '时间只带 ISO，不在模型里格式化')
  assert.equal(modified?.value, '')
  assert.equal(f?.detail.find((p) => p.label === '体积')?.value, '37.5 KB')
  assert.equal(f?.detail.find((p) => p.label === '容器形态')?.value, '明文 ZIP')
  const encrypted = byKey().get('backup-file:/h/backups/b.zip')
  assert.equal(encrypted?.detail.find((p) => p.label === '容器形态')?.value, '加密容器（导入前需解锁）')
  assert.equal(encrypted?.detail.find((p) => p.label === '备注')?.value, '改备注前的手动包')
  const m = byKey({ marketItems: [{ id: 'm-2', name: '裸条目' }] }).get('market:m-2')
  assert.deepEqual(m?.detail.map((p) => p.label), ['ID'], '缺作者/版本/更新时间 → 只剩 ID 一行')
})

test('librarySummary：只要有一条没体积，合计就是 null 而不是偏小的数字', () => {
  const onlyFiles = librarySummary(rows({ snapshots: [], remoteSnapshots: [], marketItems: [] }))
  assert.equal(onlyFiles.count, 2)
  assert.equal(onlyFiles.unknownSize, 0)
  assert.equal(onlyFiles.bytes, 38_400 + 12_600_000)
  assert.equal(onlyFiles.encrypted, 1)

  const mixed = librarySummary(rows())
  assert.equal(mixed.count, 5)
  assert.equal(mixed.unknownSize, 3, '快照/远端/市场都没有体积')
  assert.equal(mixed.bytes, null, '混进「未知」就不能给合计')
})

test('countByKind 用未筛选的行算（否则选中一个来源后其余计数会变 0）', () => {
  assert.deepEqual(countByKind(rows()), { 'snapshot': 1, 'backup-file': 2, 'remote-snapshot': 1, 'market': 1 })
})

test('filterArtifacts：来源筛选 + 分词 AND 搜索 + 大小写不敏感', () => {
  const all = rows()
  assert.equal(filterArtifacts(all, { kind: 'backup-file' }).length, 2)
  assert.equal(filterArtifacts(all, { kind: 'market' }).length, 1)
  assert.equal(filterArtifacts(all, {}).length, 5, '空查询 = 原序全量')

  assert.equal(filterArtifacts(all, { text: 'SNAP-1' }).length, 1, '快照 id 可搜且大小写不敏感')
  assert.equal(filterArtifacts(all, { text: '手动包' }).length, 1, '备注可搜')
  assert.equal(filterArtifacts(all, { text: '某配置' }).length, 1, '市场条目名可搜')
  assert.equal(filterArtifacts(all, { text: 'dsh-config' }).length, 2, '两个备份文件同名前缀')
  assert.equal(filterArtifacts(all, { text: 'dsh 12.0' }).length, 0, '两个词必须都命中')
  assert.equal(filterArtifacts(all, { text: 'dsh 手动' }).length, 1, '跨字段的 AND 命中')
  assert.equal(filterArtifacts(all, { text: '   ' }).length, 5, '纯空白 = 不过滤')
})

test('filterArtifacts：sort=name 用主标识（时间标识退化为 ISO）', () => {
  const names = filterArtifacts(rows(), { sort: 'name' }).map((r) => artifactSortKey(r))
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')), '名称序单调不减')
})

test('元数据文案走 UiT：zh/en 各自渲染，千分位固定', () => {
  const zhSnap = byKey().get('snapshot:snap-1')
  assert.deepEqual(zhSnap?.meta, ['1,204 条目', '42 插件'], '千分位 + 中文单位')
  const enSnap = toArtifactRows(input(), en).find((r) => r.key === 'snapshot:snap-1')
  assert.deepEqual(enSnap?.meta, ['1,204 entries', '42 plugins'])
  const zhFile = byKey({ backupFiles: [{ path: '/p', name: 'x.zip', sizeBytes: 1024, mtimeMs: 0, source: 'auto' }] }).get('backup-file:/p')
  assert.deepEqual(zhFile?.meta, ['自动', '1.0 KB'], '体积走 formatBytes（B/KB/MB）')
})

test('字典键映射对每个 kind / badge / capability 都穷尽（编译器已保证，这里钉住取值）', () => {
  assert.equal(zh(ARTIFACT_KIND_LABEL_KEY['remote-snapshot']), '远端快照')
  assert.equal(zh(ARTIFACT_BADGE_LABEL_KEY['current']), '当前基线')
  assert.equal(zh(ARTIFACT_CAPABILITY_LABEL_KEY['consult']), '迁移前咨询')
  assert.equal(en(ARTIFACT_CAPABILITY_LABEL_KEY['consult']), 'Pre-migration consult')
  assert.equal(zh('library.cap.unlockImport'), '解锁后导入', '加密行主操作的文案（动作仍是 import）')
})
