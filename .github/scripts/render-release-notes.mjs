#!/usr/bin/env node
/**
 * 渲染 GitHub Release 描述（通用模板渲染器，零依赖）。
 *
 * 用法：
 *   node .github/scripts/render-release-notes.mjs <tag> <template> <highlights-file> <auto-notes-file>
 * 渲染结果写 stdout（CI 重定向到 /tmp/release-notes.md），诊断写 stderr。
 *
 * 占位符（只有这 4 个会被替换，其它 {{...}} 原样保留）：
 *   {{highlights}}  CHANGELOG.md 当前版本段（中英双语亮点）
 *   {{autoNotes}}   GitHub 自动生成的变更记录（分类见 .github/release.yml）
 *   {{version}}     tag 去掉前导 v（0.1.70）
 *   {{tag}}         tag 原样（v0.1.70）
 *
 * 退出码：0 成功；1 文件读不到 / 必填占位符缺失 / 输出为空；2 参数不合法。
 * 硬要求 {{highlights}} 与 {{autoNotes}} 同时存在，理由见 .github/release-notes-template.md 的注释。
 * 其它约定：**模板自身的 HTML 注释先剥离，再做必填检查与替换** —— 顺序很关键：模板注释里通常会写
 * 占位符说明，若先替换，注释内容会被展开，随后惰性 `<!--[\s\S]*?-->` 会在被替换进来的注释（如 GitHub
 * 自动笔记首行的 provenance 注释）处提前闭合，把半截内容漏进描述（实测踩过）。被替换进来的内容里
 * 的注释**原样保留**（那通常是 GitHub 自己写的、渲染时不可见）。连续空行折叠；输出保证单个结尾换行。
 */
import { readFileSync } from 'node:fs';

const REQUIRED = ['highlights', 'autoNotes'];
const USAGE = 'usage: render-release-notes.mjs <tag> <template> <highlights-file> <auto-notes-file>';
const [tag, templatePath, highlightsPath, autoNotesPath] = process.argv.slice(2);

if (!tag || !templatePath || !highlightsPath || !autoNotesPath) {
  console.error(USAGE);
  process.exit(2);
}

function readText(file, label) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    console.error('render-release-notes: 读不到' + label + ' ' + file + '：' + (error?.message ?? error));
    process.exit(1);
  }
}

const template = readText(templatePath, '模板');
// 先剥模板注释：注释里常有占位符说明，若留到替换之后再剥会漏内容（见文件头说明）。
const templateBody = template.replace(/<!--[\s\S]*?-->/g, '');
const highlights = readText(highlightsPath, '亮点段').trim();
const autoNotes = readText(autoNotesPath, '自动变更记录').trim();

if (highlights === '') {
  console.error('render-release-notes: 亮点段为空（' + highlightsPath + '）；发布门禁要求当前版本段非空');
  process.exit(1);
}
const missing = REQUIRED.filter((key) => !templateBody.includes('{{' + key + '}}'));
if (missing.length > 0) {
  console.error(
    'render-release-notes: 模板缺少必填占位符 ' + missing.join(', ') + '（' + templatePath + '）；' +
      '请在模板里补上 {{' + missing.join('}} / {{') + '}}',
  );
  process.exit(1);
}
if (autoNotes === '') {
  console.error('render-release-notes: 警告：自动变更记录为空（' + autoNotesPath + '），描述里该段会是空的');
}

const values = { highlights, autoNotes, version: tag.replace(/^v/, ''), tag };
let out = templateBody.replace(/\r\n/g, '\n');
// split/join 而非 String.replace：不会把内容里的 $& / $' 当成替换模式解释。
for (const [key, value] of Object.entries(values)) out = out.split('{{' + key + '}}').join(value);

out = out
  .replace(/[ \t]+$/gm, '')          // 行尾空白
  .replace(/\n{3,}/g, '\n\n')       // 折叠多余空行
  .trim();

if (out === '') {
  console.error('render-release-notes: 渲染结果为空（模板只剩注释/空白？）');
  process.exit(1);
}

console.error(
  'render-release-notes: ' + tag + ' → ' + out.length + ' 字符（占位符：' +
    Object.keys(values).filter((k) => templateBody.includes('{{' + k + '}}')).join(', ') + '）',
);
process.stdout.write(out + '\n');
