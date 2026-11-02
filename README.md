# ABC Desk

English | [简体中文](#简体中文)

## English

A practice-oriented ABC music workbench delivered as a VS Code extension: a native ABC text editor alongside a music preview in the editor area — rendering, playback, keyboard visualization, source linkage, diagnostics, and exports. The extension does not embed an AI chat; the practice loop runs on plain-file collaboration between the user and an external agent with filesystem access.

> Current state: self-use trial started on 2026-11-01 from commit `9227e37`; all eight commands are implemented. The preview supports multi-tune selection, playback (speed, voices, progress, loop), keyboard hints, cross-tune source playback and per-tune settings; practice settings (speed, loop, chords, voice mutes, keyboard layout) are remembered per saved file in the extension's workspace state, migrated on save / rename / move, and reset via the preview's More menu. File lifecycle handling keeps read-only source-state pages on migration conflicts or unavailable sources and re-verifies automatically when the source becomes readable again. MIDI / SVG exports remain independent of preview selection. Automated checks and builds pass; F5 acceptance passed for the multi-tune changes (2026-10-02), and remains pending (recorded, not waived) for the lifecycle, diagnostics and settings changes. Parse warnings with reliable source positions are published to the Problems panel and cleared as versions change (see `docs/plan.md`). The next phase is real practice and incremental detail fixes; VSIX packaging and store release remain deferred.

After edits, tune identity is retained only when its non-empty `X:` value is unchanged and unique in both versions; otherwise, select the tune again (including single tunes without `X:`). Manual tune changes stop playback and reset position without preparing audio. Settings are remembered per saved file by default (disable with `abcdesk.rememberPracticeSettings`); unsaved documents keep settings for the session only until first save. See `docs/manual-checks.md` for the F5 handoff.

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

> 当前进入自用试行（2026-11-01，基线 `9227e37`）：8 个命令全部实现。预览已支持多曲目选择、播放（变速 / 声部 / 进度 / 循环）、键盘提示、跨曲源码起播及逐曲设置；练习设置（速度、循环、伴奏、声部静音、键盘布局）按已保存文件记忆在扩展的工作区状态中，随保存 / 重命名 / 移动迁移，并可从预览“更多”菜单重置本文件。文件生命周期已覆盖保存 / 重命名 / 移动时的绑定接续与迁移，冲突或来源不可用时保留只读状态页，来源恢复后自动重新核验。MIDI / SVG 导出保持独立选曲，不跟随预览选曲。自动检查与构建通过；多曲目改动的 F5 人工验收（2026-10-02）通过，生命周期、诊断与设置持久化的 F5 验收继续挂账（未视为通过）；解析告警按可靠源码位置发布到问题面板并随版本清理（见 `docs/plan.md`）。下一阶段以真实练习与细节优化为主；VSIX 打包与商店发布暂缓。

编辑后，仅当非空 `X:` 在新旧版本均唯一且不变时保留曲目身份，否则需要重新选择（无 `X:` 单曲也须确认）。手动切曲停音归零，不准备音频。设置默认按已保存文件记忆（可用 `abcdesk.rememberPracticeSettings` 关闭）；未保存文档仅在本次会话内保留，首次保存后开始记忆。F5 验收记录见 `docs/manual-checks.md`。

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
