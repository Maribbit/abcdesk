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

按读者分层，每层只保留一种语言，不维护双语副本（决策见 `docs/decisions.md` 2026-11-02）：

| 层 | 语言 | 说明 |
| --- | --- | --- |
| 代码标识符、API 名、提交信息 | 英文 | 不变 |
| 代码注释、测试标题、脚本输出 | 英文 | 面向外部贡献者；`[SPEC-xx]` 引用与语言无关，追溯不受影响。字符串内嵌的 CSS / HTML 注释同样英文 |
| `README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、商店文案 | 英文为主 | README 保留简短中文入口段，不做全文双语 |
| `docs/`（spec / plan / decisions / manual-checks / 本文） | 中文 | 维护者工作语言，唯一事实源；需要时由 agent 按需翻译，不维护英文副本 |
| `samples/course/` 学习材料 | 中文 | 只面向维护者本人 |
| 产品 UI 文案 | 英文默认 + 简体中文 | 跟随 VS Code 显示语言（L10N 域） |

- `scripts/spec-check.mjs` 解析的 spec 标记（如 `- 验证：auto / manual`）跟随 `docs/` 用中文；脚本自身的提示输出用英文。
- 现有中文注释一次性转换为英文后，新增注释一律英文；规格文档中的引用以条目 ID 对照，不依赖注释措辞。

## 提交习惯

- conventional commits 前缀：feat / fix / docs / refactor / test / chore。
- 提交动作由用户发起，代理不自动提交。
- 每次提交前 `npm run check` 全绿。
