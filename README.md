# ABC Desk

English | [简体中文](#简体中文)

## English

A practice-oriented ABC music workbench delivered as a VS Code extension: a native ABC text editor alongside a music preview in the editor area — rendering, playback, keyboard visualization, source linkage, diagnostics, and exports. The extension does not embed an AI chat; the practice loop runs on plain-file collaboration between the user and an external agent with filesystem access.

> Current state: M0 technical spike in progress — all eight commands are implemented. The preview supports multi-tune selection, playback (speed, voices, progress, loop), keyboard hints, cross-tune source playback and per-tune settings within the current preview; file lifecycle handling migrates preview bindings on save / rename / move, keeps read-only source-state pages on migration conflicts or unavailable sources, and re-verifies automatically when the source becomes readable again. MIDI / SVG exports remain independent of preview selection. Automated checks and builds pass; F5 acceptance passed for the multi-tune changes (2026-10-02), and is pending for the lifecycle and diagnostics changes. Parse warnings with reliable source positions are published to the Problems panel and cleared as versions change; settings persistence remains unimplemented (see `docs/plan.md`).

After edits, tune identity is retained only when its non-empty `X:` value is unchanged and unique in both versions; otherwise, select the tune again (including single tunes without `X:`). Manual tune changes stop playback and reset position without preparing audio. Settings are held only in the current preview, not restored after closing it. See `docs/manual-checks.md` for the F5 handoff.

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

> 当前处于 M0 技术 spike 执行阶段：8 个命令全部实现。预览已支持多曲目选择、播放 （变速 / 声部 / 进度 / 循环）、键盘提示、跨曲源码起播及本次预览内的逐曲设置；文件生命周期已覆盖保存 / 重命名 / 移动时的绑定接续与迁移，冲突或来源不可用时保留只读状态页，来源恢复后自动重新核验。MIDI / SVG 导出保持独立选曲，不跟随预览选曲。自动检查与构建通过；多曲目改动的 F5 人工验收（2026-10-02）通过，生命周期与诊断改动的 F5 验收待执行；解析告警按可靠源码位置发布到问题面板并随版本清理；设置持久化尚未实现（见 `docs/plan.md`）。

编辑后，仅当非空 `X:` 在新旧版本均唯一且不变时保留曲目身份，否则需要重新选择（无 `X:` 单曲也须确认）。手动切曲停音归零，不准备音频。设置仅保留在本次预览中，关闭后不恢复。F5 验收记录见 `docs/manual-checks.md`。

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
