# 开发规范

## 文档分层

| 层 | 文件 | 职责 | 规范性 |
| --- | --- | --- | --- |
| 方向层 | `docs/plan.md` | 里程碑、当前阶段、开放决策、范围红线 | 方向约束 |
| 契约层 | `docs/spec/` | 可验收的规格条目 | 唯一验收来源 |
| 流程层 | 本文件 | 开发流程、完成定义、分层边界 | 流程约束 |
| 记录层 | `docs/decisions.md`、`docs/manual-checks.md` | 新决策登记、人工验证登记 | 过程记录 |
| 冻结层 | `docs/archive/` | D0 历史文档冻结副本 | 仅追溯，不参与验收 |

## 核心流程（每个行为改动）

1. 决策登记：涉及未确认行为（P01–P06、G01）时先回到用户确认，并在 `docs/decisions.md` 记录；未确认前不实现。
2. 更新 spec：在对应域文件新增 / 修改条目（规范、验证、里程碑、依据四字段齐全）。
3. 绑定测试：新增 / 修改带 `[SPEC-域-序号]` 前缀的测试；未实现用 `it.todo('[SPEC-...] ...')` 占位；manual 条目在 `docs/manual-checks.md` 登记。
4. 实现：代码只为实现已写明的规格条目，不夹带未登记行为。
5. 验证：`npm run check` 全绿（typecheck + lint + test + spec:check）。

顺序不可颠倒：先规格，后实现；spec 是唯一验收来源。

## 完成定义（Definition of Done）

- 对应规格条目存在且无歧义；
- 绑定测试通过（manual 条目已登记并完成人工执行记录）；
- `npm run spec:check` 无未绑定条目、无悬空引用；
- `npm run check` 全绿。

## 规格与绑定规范

- ID：`SPEC-<域>-<两位序号>`，只增不废——废弃时保留原文并标注"已废弃"，不回收序号。
- 引用：测试标题以 `[SPEC-域-序号]` 前置；同一测试可引用多个条目。
- 变更流程：先改 spec（注明依据与新决策），同步测试与 `docs/decisions.md`，再改实现。
- 条目必须可判定：避免"尽量""合理"等模糊词；依赖 F5 调试宿主、真实音频、Remote 或性能实测的条目用 manual 登记。

## 目录分层边界

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/core` | 宿主无关逻辑（平移 player / abc-quality / exports） | 不得 import vscode；ESLint `no-restricted-imports` 强制 |
| `src/extension` | 激活、命令、预览管理、消息桥 | 只用 vscode API 与 `workspace.fs`；不依赖本机路径与 Node `fs` |
| `src/webview` | 播放器 UI | 只经消息桥与宿主通信；不得 import vscode |
| `media/soundfonts` | 本地音色 | 不走网络，经 `asWebviewUri` 加载 |

## 语言与文案

- 文档（`docs/`）一律中文；`README.md` 中英双语（英文在前、简体中文在后）；代码标识符、API 名与提交信息英文。
- 代码注释用中文说明（与 `docs/spec` 条目语言一致，便于对照追溯）。
- 产品 UI 文案：英文默认 + 简体中文、跟随 VS Code 显示语言（L10N 域补全后以 spec 为准）。

## 提交习惯

- conventional commits 前缀：feat / fix / docs / refactor / test / chore。
- 提交动作由用户发起，代理不自动提交。
- 每次提交前 `npm run check` 全绿。
