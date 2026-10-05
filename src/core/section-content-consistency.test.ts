/**
 * t14 / core-F3 回归：ZIP 里**实际带着**某个文件分区的内容、而 manifest.sections 没把它声明为包含时，
 * 必须显式告警 —— 这些条目不会被导入，「包里有、没人说」不能变成静默忽略。
 *
 * 修前实测（base sha 3f42a8b1）：analyzeImport 返回 warnings=[]，包内自定义技能条目连名字都不出现，
 * 用户会以为备份内容都导进去了（本仓库记录在案的第一大类坑：集合类分区「报成功但条目缺失」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Importer } from './importer.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { writeZip } from '../utils/zip.ts';
import { buildManifest } from '../schema/manifest.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { SECTION_IDS, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import type { SectionId } from '../schema/types.ts';

const SETTINGS = JSON.stringify({ version: 1, namespaces: { llm: { value: { model: 'deepseek-chat' }, revision: 1, secrets: [] } } });
const DECISIONS = { strategy: 'merge' as const, resolutions: {}, pathMappings: [] };
/** prompts 分区的 JSON 载荷路径（从注册表派生，避免测试写死布局） */
const PROMPTS_JSON = SECTION_JSON_PATHS['prompts']!;
const PROMPTS_PAYLOAD = Buffer.from(JSON.stringify({ version: 1, entries: [] }), 'utf8');
/** skills 分区在 ZIP 内的真实前缀（custom/skills/），从注册表派生，避免测试写死布局。 */
const SKILL_PREFIX = SECTION_FILE_PREFIXES['skills']!;
const SKILL_ENTRY = SKILL_PREFIX + 'demo/SKILL.md';

/** 造包：settings 必选；skills 是否在 manifest.sections 里声明为包含由参数决定。 */
async function buildBundle(opts: {
  declareSkills?: boolean;
  /** 覆盖 manifest.sections 的开关（缺省 = 除 settings 外全 false） */
  flags?: Record<string, boolean>;
  /** 追加 ZIP 条目（造「包里有内容」的形态） */
  extraEntries?: { name: string; data: Buffer }[];
}): Promise<{ zipPath: string; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-t14-f3-'));
  const flags: Record<string, boolean> = {};
  for (const sid of SECTION_IDS) flags[sid] = false;
  flags['settings'] = true;
  flags['skills'] = opts.declareSkills === true;
  for (const [sid, on] of Object.entries(opts.flags ?? {})) flags[sid] = on;
  const manifest = buildManifest({
    exporterVersion: '0.1.0',
    dshVersion: '0.1.54',
    platform: 'win32',
    arch: 'x64',
    sections: flags as Record<SectionId, boolean>,
    containsSecrets: false,
    encrypted: false,
    encryption: null,
  });
  const entries = [
    { name: 'config/settings.json', data: Buffer.from(SETTINGS, 'utf8') },
    { name: SKILL_ENTRY, data: Buffer.from('# demo skill', 'utf8') },
    ...(opts.extraEntries ?? []),
  ];
  const checksums = buildChecksums(entries);
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') });
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify(checksums), 'utf8') });
  const zipPath = path.join(tmp, 'bundle.zip');
  await writeZip(zipPath, entries);
  return { zipPath, tmp };
}

function mkImporter(): Importer {
  return new Importer({
    ctx: makeContext('linux', '/home/bob'),
    adapters: createAdapters({ namespaces: ['llm'] }),
    snapshotStore: new MemSnapshotStore(),
  });
}

test('core-F3：包内有未声明的文件分区内容 → analyzeImport 必须显式告警（不得静默忽略）', async () => {
  const { zipPath, tmp } = await buildBundle({ declareSkills: false });
  try {
    const analysis = await mkImporter().analyzeImport(zipPath);
    assert.ok(
      analysis.warnings.some((w) => w.includes('skills')),
      '未声明的 skills 分区内容必须出现在 warnings 里（修前是零告警）',
    );
    // 行为不变：未声明的条目不会被导入（只是「必须可见」）
    assert.ok(!analysis.sectionsInZip.includes('skills'), '未声明的分区仍不得进入导入载荷');
    // 计划里同样不得出现这些条目（避免「以为导了」）
    const plan = await mkImporter().createImportPlan(zipPath, DECISIONS);
    assert.equal(plan.items.filter((i) => i.adapter === 'skills').length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('core-F3 对照：正常声明的 skills 分区不得产生「未声明」误报', async () => {
  const { zipPath, tmp } = await buildBundle({ declareSkills: true });
  try {
    const analysis = await mkImporter().analyzeImport(zipPath);
    assert.ok(analysis.sectionsInZip.includes('skills'), '声明为包含的分区必须照旧进入载荷');
    assert.ok(
      !analysis.warnings.some((w) => w.includes('skills')),
      '正常声明的分区不得被误报成「未声明内容」',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('core-F3/R1：未声明的 JSON 载荷（custom/prompts.json）+ prompts=false → 必须告警（不得静默忽略）', async () => {
  const { zipPath, tmp } = await buildBundle({
    declareSkills: false,
    extraEntries: [{ name: PROMPTS_JSON, data: PROMPTS_PAYLOAD }],
  });
  try {
    const analysis = await mkImporter().analyzeImport(zipPath);
    assert.ok(
      analysis.warnings.some((w) => w.includes('prompts')),
      '未声明的 JSON 分区载荷必须出现在 warnings 里（base sha 3f42a8b 上零告警）',
    );
    assert.ok(!analysis.sectionsInZip.includes('prompts'), '未声明的 JSON 分区仍不得进入导入载荷');
    const plan = await mkImporter().createImportPlan(zipPath, DECISIONS);
    assert.equal(plan.items.filter((i) => i.adapter === 'prompts').length, 0, '未声明的 JSON 载荷不得产生计划项');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('core-F3/R1：未声明的 JSON 载荷（config/settings.json）+ settings=false → 必须告警', async () => {
  const { zipPath, tmp } = await buildBundle({ flags: { settings: false }, declareSkills: true });
  try {
    const analysis = await mkImporter().analyzeImport(zipPath);
    assert.ok(
      analysis.warnings.some((w) => w.includes('settings')),
      '未声明的 settings JSON 载荷必须告警（修前 warnings=[] 且该分区不在 sectionsInZip）',
    );
    assert.ok(!analysis.sectionsInZip.includes('settings'), '未声明 → 不进载荷');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('core-F3/R1 对照：已声明的 JSON 分区不得被误报成「未声明内容」', async () => {
  const { zipPath, tmp } = await buildBundle({ declareSkills: true });
  try {
    const analysis = await mkImporter().analyzeImport(zipPath);
    assert.ok(analysis.sectionsInZip.includes('settings'), 'declared settings（JSON 分区）必须照旧进载荷');
    assert.ok(
      !analysis.warnings.some((w) => w.includes('未声明的分区内容')),
      '已声明的 file/JSON 分区都不得被误报：' + JSON.stringify(analysis.warnings),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('core-F3/R1 对照：非 JSON 分区的条目不得被当成 JSON 载荷误报', async () => {
  const { zipPath, tmp } = await buildBundle({
    declareSkills: true,
    extraEntries: [{ name: 'docs/readme.txt', data: Buffer.from('hello', 'utf8') }],
  });
  try {
    const analysis = await mkImporter().analyzeImport(zipPath);
    assert.ok(
      !analysis.warnings.some((w) => w.includes('未声明的分区内容')),
      '与任何分区载荷无关的条目不得触发未声明告警：' + JSON.stringify(analysis.warnings),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('core-F3/R1：文件分区与 JSON 载荷同时未声明 → 同一条告警里两者都列出', async () => {
  const { zipPath, tmp } = await buildBundle({
    declareSkills: false,
    extraEntries: [{ name: PROMPTS_JSON, data: PROMPTS_PAYLOAD }],
  });
  try {
    const analysis = await mkImporter().analyzeImport(zipPath);
    const hit = analysis.warnings.find((w) => w.includes('未声明的分区内容'));
    assert.ok(hit !== undefined, '必须有未声明内容告警');
    assert.ok(hit!.includes('skills') && hit!.includes('prompts'), '两类载荷都要列出：' + hit!);
    assert.ok(hit!.includes(SKILL_ENTRY) && hit!.includes(PROMPTS_JSON), '示例条目要含文件条目与 JSON 路径：' + hit!);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
