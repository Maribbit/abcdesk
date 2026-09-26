import { describe, it } from 'vitest';

// 骨架阶段占位：CMD 域已全量蒸馏（docs/spec/cmd.md），行为实现时逐条替换为真实断言。
// it.todo 同样计入 spec-check 的绑定引用（见 scripts/spec-check.mjs）。

describe('命令与入口（SPEC-CMD 域）', () => {
  it.todo('[SPEC-CMD-02] 命令分组为 "ABC Desk"，可在相关上下文发现并自行绑定，不新增默认组合键');
  it.todo('[SPEC-CMD-03] 同文件复用已有预览不重复创建、只显示不新起播（运行时行为）');
  it.todo('[SPEC-CMD-07] 播放与从光标播放可按需打开预览并保留源码焦点，停止不新建预览');
  it.todo('[SPEC-CMD-08] 从光标播放与从所选音符播放上下文分离，不做跨源回退');
  it.todo('[SPEC-CMD-09] 播放／暂停控制当前曲目不跟随光标，准备中执行取消起播');
  it.todo('[SPEC-CMD-10] 停止与取消始终可达，不因音频未就绪或内容错误失效');
  it.todo('[SPEC-CMD-11] 命令与预览按钮共用操作规则，启用条件与执行校验分离');
  it.todo('[SPEC-CMD-12] 转到源码编辑只打开来源文件，无映射不套用旧偏移');
  it.todo('[SPEC-CMD-13] 导出使用执行时文档快照，多曲目每次确认一首');
  it.todo('[SPEC-CMD-14] 迁移来源状态页不再是可控音乐目标');
});
