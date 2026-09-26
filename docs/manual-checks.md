# 人工验证登记（manual checks）

`docs/spec/` 中验证方式为 `manual` 的条目在此登记；`scripts/spec-check.mjs` 双向校验：
每个 manual 条目至少有一条登记，所有 `[SPEC-域-序号]` 引用必须能在 spec 中定义。

登记格式（引用置于列表项中）：

```text
- [ ] [SPEC-<域>-<序号>] 场景与步骤；判据（预期结果）。
```

当前无 manual 条目。各域补全时，凡依赖 F5 调试宿主、真实音频、Remote 或性能实测的条目改用本清单登记。
