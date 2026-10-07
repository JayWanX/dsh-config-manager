#!/usr/bin/env node
/**
 * CHANGELOG 版本段的脚手架与格式门禁（零依赖）。
 *
 * 用法：
 *   node .github/scripts/changelog-section.mjs release <version> [--date YYYY-MM-DD] [--changelog CHANGELOG.md]
 *   node .github/scripts/changelog-section.mjs check   <version> [--changelog CHANGELOG.md]
 *
 * release：把 `## [Unreleased]` 改名成 `## [<version>] - <date>`（内容原样保留），并在顶部插入
 *          .github/changelog-template.md 渲染出的新 `## [Unreleased]` 骨架 —— 下一轮从同一结构起步。
 *          版本段已存在 / 找不到 [Unreleased] 一律报错（不做猜测性修复）。
 * check  ：校验该版本段是否符合 .github/changelog-template.md 的结构；不符合则列出全部问题并退出 1。
 *          publish.yml 在 npm publish 之前调用它，保证「文档里写的格式」= 「实际发出去的格式」。
 *
 * 退出码：0 通过；1 校验失败 / 状态不允许；2 参数或文件问题。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TEMPLATE = '.github/changelog-template.md';
const args = process.argv.slice(2);
const command = args[0];
const option = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const version = (args[1] ?? '').replace(/^v/, '');
const changelogPath = option('changelog', 'CHANGELOG.md');
const templatePath = option('template', TEMPLATE);

function usage(message) {
  console.error(message);
  console.error('usage: changelog-section.mjs release <version> [--date YYYY-MM-DD] [--changelog CHANGELOG.md]');
  console.error('       changelog-section.mjs check   <version> [--changelog CHANGELOG.md]');
  process.exit(2);
}
if (command !== 'release' && command !== 'check') usage('未知子命令：' + String(command));
if (!/^\d+\.\d+\.\d+/.test(version)) usage('版本号不合法：' + JSON.stringify(version));

function readText(file, label) {
  try { return readFileSync(file, 'utf8'); } catch (error) {
    console.error('changelog-section: 读不到' + label + ' ' + file + '：' + (error?.message ?? error));
    process.exit(2);
  }
}

const source = readText(changelogPath, 'CHANGELOG');
const lines = source.replace(/\r\n/g, '\n').split('\n');
const headingIndex = (re) => lines.findIndex((l) => re.test(l));
const versionHeading = (v) => new RegExp('^## \\[v?' + v.replace(/\./g, '\\.') + '\\](\\s|$)');

function sliceSection(versionLineRegex) {
  const start = headingIndex(versionLineRegex);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { start, end, body: lines.slice(start, end) };
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ---------------------------------------------------------------- check
function check() {
  const section = sliceSection(versionHeading(version));
  if (section === null) {
    console.error('changelog-section: CHANGELOG.md 里找不到 ## [' + version + '] 版本段' +
      '（发布前需要先跑 `changelog-section.mjs release ' + version + '` 把 [Unreleased] 收口）');
    process.exit(1);
  }
  const body = section.body;
  const problems = [];
  const heading = body[0] ?? '';
  const wantHeading = new RegExp('^## \\[v?' + version.replace(/\./g, '\\.') + '\\] - \\d{4}-\\d{2}-\\d{2}$');
  if (!wantHeading.test(heading)) {
    problems.push('标题必须是 `## [' + version + '] - YYYY-MM-DD`（带 ISO 日期），实际：' + heading);
  }
  const quoteLines = body.filter((l) => l.startsWith('>'));
  if (quoteLines.length === 0) problems.push('缺少引用块（`> `）—— 版本段的主题/亮点必须写在引用块里');
  if (!body.some((l) => /^> \*\*Theme\*\*[:：]/.test(l))) {
    problems.push('引用块里缺少英文主题行：`> **Theme**: one-line English theme`');
  }
  if (!/[\u4e00-\u9fff]/.test(body.join('\n'))) problems.push('缺少中文内容（本文件是双语亮点）');
  // 每个 ### 小节后面必须有内容
  body.forEach((l, i) => {
    if (!/^### /.test(l)) return;
    let j = i + 1;
    while (j < body.length && !/^#{2,3} /.test(body[j])) j += 1;
    const content = body.slice(i + 1, j).filter((x) => x.trim() !== '');
    if (content.length === 0) problems.push('小节「' + l.trim() + '」是空标题，后面没有内容');
  });
  const placeholder = body.find((l) => /\{\{[^}]*\}\}/.test(l));
  if (placeholder !== undefined) {
    problems.push('残留未填写的占位符（骨架没填完）：' + placeholder.trim().slice(0, 80));
  }
  if (problems.length > 0) {
    console.error('changelog-section: ## [' + version + '] 版本段不符合 ' + TEMPLATE + '：');
    for (const p of problems) console.error('  · ' + p);
    process.exit(1);
  }
  console.error('changelog-section: ## [' + version + '] 结构符合 ' + TEMPLATE + '（' + body.length + ' 行）');
}

// -------------------------------------------------------------- release
function release() {
  const existing = sliceSection(versionHeading(version));
  if (existing !== null) {
    console.error('changelog-section: ## [' + version + '] 已存在（第 ' + (existing.start + 1) + ' 行）—— ' +
      '不重复收口；若上一次只是改了标题，请手工检查。');
    process.exit(1);
  }
  const unreleased = lines.map((l, i) => (l === '## [Unreleased]' ? i : -1)).filter((i) => i >= 0);
  if (unreleased.length !== 1) {
    console.error('changelog-section: 需要恰好一个 `## [Unreleased]`，实际 ' + unreleased.length + ' 个');
    process.exit(1);
  }
  const at = unreleased[0];
  const date = option('date', todayLocal());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) usage('日期不合法（要 YYYY-MM-DD）：' + JSON.stringify(date));

  const template = readText(templatePath, '模板').replace(/<!--[\s\S]*?-->/g, '');
  const skeleton = template
    .replace(/\{\{heading\}\}/g, 'Unreleased')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n');

  const out = [
    ...lines.slice(0, at),
    ...skeleton,
    '',
    '## [' + version + '] - ' + date,
    ...lines.slice(at + 1),
  ];
  writeFileSync(changelogPath, out.join('\n'), 'utf8');
  console.error('changelog-section: [Unreleased] → ## [' + version + '] - ' + date +
    '；已在顶部开好新的 [Unreleased] 骨架（' + skeleton.length + ' 行）。');
}

if (command === 'check') check();
else release();
