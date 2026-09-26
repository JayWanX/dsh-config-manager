/**
 * Issue 模板一致性护栏（.github/ISSUE_TEMPLATE）。
 *
 * 背景：同一份表单刻意维护成中英两个文件（`x.yml` 中文 / `x.en.yml` 英文）——
 * 与 README.md + README.zh-CN.md 同一个取舍：换来的是英文用户拿到**纯英文**表单
 * （下拉选项也全英文），代价是同一处改动要改两遍。
 *
 * 而「改了两遍」漏掉一次不会有任何报错：只是另一边的用户少填一栏、或某个字段
 * 悄悄变成非必填、「受影响的功能」少一个选项。本文件把这条不变量钉死：
 *
 *  1. 每个模板都能被 YAML 解析，body 非空、首个元素是说明用的 markdown；
 *  2. 中英配对：base 名相同的两个文件必须同时存在（不允许落单）；
 *  3. 配对的两份：title 前缀、labels、元素顺序 / type / id / 必填标志**逐项一致**；
 *  4. 同一文件内 id 不重复，且符合 GitHub 允许的字符集，输入元素都有 attributes.label。
 *
 * 变异验证：把任一份文件的某个 id 改名、把 required 由 true 改成 false、
 * 删掉一个元素、改掉 labels —— 本测试必须红灯。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(import.meta.dirname, '..');
const templateDir = path.join(repoRoot, '.github', 'ISSUE_TEMPLATE');

interface FormElement {
  type: string;
  id?: string;
  attributes?: { label?: string };
  validations?: { required?: boolean };
}

interface IssueForm {
  name?: string;
  description?: string;
  title?: string;
  labels?: string[];
  body?: FormElement[];
}

function loadForms(): Map<string, IssueForm> {
  const files = readdirSync(templateDir).filter((f) => f.endsWith('.yml') && f !== 'config.yml');
  const forms = new Map<string, IssueForm>();
  for (const f of files) {
    const raw = readFileSync(path.join(templateDir, f), 'utf8');
    const doc = yaml.load(raw) as IssueForm | undefined;
    assert.ok(doc !== undefined && typeof doc === 'object', `${f}: YAML 解析结果必须是一个对象`);
    forms.set(f, doc);
  }
  return forms;
}

const forms = loadForms();
const fileNames = [...forms.keys()];
const baseOf = (f: string): string => f.replace(/\.en\.yml$/, '').replace(/\.yml$/, '');
const isEnglish = (f: string): boolean => f.endsWith('.en.yml');
const zhFiles = fileNames.filter((f) => !isEnglish(f));

test('模板目录：每个模板都有中英两份，没有落单的文件', () => {
  assert.ok(fileNames.length >= 2, '至少应有一个模板');
  const unpaired = fileNames.filter((f) => {
    const counterpart = isEnglish(f) ? f.replace(/\.en\.yml$/, '.yml') : f.replace(/\.yml$/, '.en.yml');
    return !fileNames.includes(counterpart);
  });
  assert.deepEqual(unpaired, [], `以下模板缺少另一种语言的配对文件: ${unpaired.join(', ')}`);
});

test('每个模板：body 非空、元素带合法且唯一的 id、输入元素都有 label', () => {
  for (const [file, form] of forms) {
    const body = form.body ?? [];
    assert.ok(body.length > 0, `${file}: body 不能为空`);
    assert.equal(body[0]?.type, 'markdown', `${file}: 第一个元素应是说明用的 markdown 块`);
    const ids = body.filter((e) => e.type !== 'markdown').map((e) => e.id ?? '');
    assert.ok(ids.length > 0, `${file}: 至少要有一个输入元素`);
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9_-]+$/, `${file}: 元素 id 只能含字母/数字/下划线/短横线，实际为 ${JSON.stringify(id)}`);
    }
    assert.equal(new Set(ids).size, ids.length, `${file}: 元素 id 不能重复（GitHub 会拒绝重复 id 的表单）`);
    for (const el of body) {
      if (el.type === 'markdown') continue;
      assert.ok((el.attributes?.label ?? '').length > 0, `${file}#${el.id}: 必须有 attributes.label`);
    }
  }
});

test('中英配对：title 前缀与 labels 完全一致', () => {
  for (const file of zhFiles) {
    const zh = forms.get(file) as IssueForm;
    const en = forms.get(`${baseOf(file)}.en.yml`) as IssueForm;
    assert.equal(en.title, zh.title, `${baseOf(file)}: 中英模板的 title 前缀必须一致（issue-labeler 的兜底规则依赖它）`);
    assert.deepEqual(en.labels, zh.labels, `${baseOf(file)}: 中英模板的自动标签必须一致`);
  }
});

test('中英配对：元素顺序 / type / id / 必填标志逐项一致（防漂移）', () => {
  const shape = (b: FormElement[]): string[] =>
    b.map((e) => `${e.type}:${e.id ?? '-'}:${e.validations?.required === true ? 'required' : 'optional'}`);
  for (const file of zhFiles) {
    const zh = (forms.get(file) as IssueForm).body ?? [];
    const en = (forms.get(`${baseOf(file)}.en.yml`) as IssueForm).body ?? [];
    assert.deepEqual(
      shape(en),
      shape(zh),
      `${baseOf(file)}: 中英模板的字段结构不一致 —— 新增/删除字段、改 id 或改必填时两边必须同步`,
    );
  }
});
