# ABC Desk

English | [简体中文](#简体中文)

## English

A practice-oriented ABC music workbench delivered as a VS Code extension: a native ABC text editor alongside a music preview in the editor area — rendering, playback, keyboard visualization, source linkage, diagnostics, and exports. The extension does not embed an AI chat; the practice loop runs on plain-file collaboration between the user and an external agent with filesystem access.

> Current state: M0 technical spike in progress — all eight commands are implemented; the preview covers rendering, playback (speed, voices, progress, loop), keyboard hints and source linkage, and MIDI / SVG exports generate independently of the preview; multi-tune documents, settings persistence and diagnostics are still pending (see `docs/plan.md`).

### Documents

- Development plan and current phase: `docs/plan.md`
- Acceptance contracts (spec items): `docs/spec/` (start with `00-index.md`)
- Development conventions: `docs/conventions.md`
- Decision log: `docs/decisions.md`
- Frozen D0 discussion (reference only, non-normative): `docs/archive/`

### Commands

```bash
npm install
npm run build        # esbuild dual bundle -> out/
npm run watch        # watch mode for development
npm run check        # typecheck + lint + test + spec:check
```

Debugging: press F5 in VS Code to launch the Extension Development Host, then search `ABC Desk:` in the Command Palette.

## 简体中文

面向练习的 ABC 音乐工作台，以 VS Code 扩展形式实现：原生 ABC 文本编辑器 + Editor 区音乐预览（渲染、播放、键盘可视化、联动、诊断、导出）。插件不集成 AI 对话；学习循环由用户与具备文件系统访问能力的外部 agent 通过普通文件协作完成。

> 当前处于 M0 技术 spike 执行阶段：8 个命令全部实现；预览已具备渲染、播放（变速、声部、进度、循环）、键盘提示与源码联动，导出 MIDI / SVG 已可独立于预览生成；多曲目文档、设置持久化与问题面板诊断待补（见 `docs/plan.md`）。

### 文档入口

- 开发计划与当前阶段：`docs/plan.md`
- 验收契约（规格条目）：`docs/spec/`（先读 `00-index.md`）
- 开发规范：`docs/conventions.md`
- 决策记录：`docs/decisions.md`
- D0 历史讨论（冻结，不具规范性）：`docs/archive/`

### 常用命令

```bash
npm install
npm run build        # esbuild 双 bundle -> out/
npm run watch        # 开发监听
npm run check        # typecheck + lint + test + spec:check
```

调试：在 VS Code 中按 F5 启动 Extension Development Host；命令面板搜索 `ABC Desk:`。
