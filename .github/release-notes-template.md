<!--
  Release 描述模板（通用）—— 由 .github/scripts/render-release-notes.mjs 渲染，
  publish.yml 的「Create GitHub Release」步骤调用。改这个文件即可调整后续所有 release 的描述。

  可用占位符（只替换这 4 个；其它 {{...}} 原样保留）：
    {{highlights}}  CHANGELOG.md 当前版本段（中英双语亮点，extract-release-notes.py 抽取）
    {{autoNotes}}   GitHub 自动生成的变更记录（分类见 .github/release.yml，含 New Contributors / Full Changelog）
    {{version}}     纯版本号，如 0.1.70（不带 v）
    {{tag}}         tag 名，如 v0.1.70

  {{highlights}} 与 {{autoNotes}} 是**必填**：缺任一个渲染器直接失败（退出码 1），
  因为发布门禁会在 npm publish 之前先做一次 dry-run，避免出现「包已发到 npm、release 描述没写」的半成品。
  本文件里的 HTML 注释不会进入最终描述（渲染器先剥注释、再替换占位符；被替换进来的内容里的注释原样保留）。
-->

{{highlights}}

## 📦 安装 / Install

```bash
dsh plugin --profile web add dsh-config-manager@{{version}}
```

> 建议装**精确版本**（而不是 `@latest`）：pnpm 的 `minimumReleaseAge` 会让刚发布的版本在 30 天内解析不到。
> Pin the **exact version** (not `@latest`): pnpm's `minimumReleaseAge` may skip a fresh release for 30 days.

## 🔄 变更记录 / Changelog（自动生成）

{{autoNotes}}
