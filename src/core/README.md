# src/core

宿主无关代码区（M0 起从 chatmusic 平移 player / abc-quality / exports）。

- 本目录代码不得 import `vscode`（由 ESLint `no-restricted-imports` 强制）。
- 需要宿主能力时以参数传入（文档文本、文档标识、路径经调用方解析）。
- 相关规格域：DOC / PLAY / STATE / EXP / PERF（见 `docs/spec/`）。
