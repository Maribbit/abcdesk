# 决策记录

轻量格式：每条含 日期 / 决策 / 理由；后续新决策追加在文件头部（时间倒序）。

## 2026-09-26 初始化审阅调整

- 决策：仓库结构与工具解耦——不使用 `.qoder/` 等工具专属目录；铁律与流程统一以 `docs/conventions.md` 为唯一入口（`docs/plan.md` 引用已同步）。
- 决策：`README.md` 采用中英双语（英文在前），其余 `docs/` 文档维持中文约定。
- 决策：依赖版本策略——`@types/vscode` 保持 1.75.0 精确锁定对齐开发基线；TypeScript 与 Vitest 保持当前 major（7.0 与 5.0 均为刚发布的 major 升级，暂不跟进）；`esbuild` 升至 ^0.28.2，`@types/node` 对齐运行时至 ^22（开发机与目标环境均为 Node 22）。
- 理由：初始结构与工具无关，避免工具目录成为规范载体；README 面向双语读者，文档内部保持中文一致；依赖以“稳定且匹配运行时”优先，不做版本追逐。
- 影响：调整后 `npm run check` 与 `npm run build` 全绿。

## 2026-09-26 项目初始化

- 决策：仓库采用三层文档结构——`docs/plan.md`（方向）、`docs/spec/`（唯一验收契约）、`docs/conventions.md`（流程）；`docs/archive/` 冻结 D0 文档仅作追溯。
- 决策：规格↔测试双向绑定——测试标题前置 `[SPEC-域-序号]`，未实现用 `it.todo` 占位，manual 条目登记于 `docs/manual-checks.md`；`scripts/spec-check.mjs` 纳入 `npm run check`。
- 决策：工具链沿用旧仓库习惯——TypeScript strict、ESLint flat config（typescript-eslint）、Vitest、esbuild 双 bundle（extension CJS + webview IIFE）。
- 决策：规格蒸馏采用"示范域先行"——CMD 域全量蒸馏（SPEC-CMD-01～14），SET 域先蒸馏首条（SPEC-SET-01），其余域建档并将补全顺序登记在 `docs/plan.md`。
- 决策：`engines.vscode` 取 `^1.75.0` 为开发基线（`@types/vscode` 同步精确锁定 1.75.0），终值待 E03 实测后回填。
- 理由：控制初始化体量，同时让方向（plan）、验收（spec）与实现（test）互相锁定，避免开发过程偏离 D0 已确认设计。
- 影响：骨架阶段不实现任何命令行为；`docs/archive/` 不参与验收。
