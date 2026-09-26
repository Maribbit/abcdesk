import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 骨架阶段占位：CMD 域已全量蒸馏（docs/spec/cmd.md），行为实现时逐条替换为真实断言。
// it.todo 同样计入 spec-check 的绑定引用（见 scripts/spec-check.mjs）。

interface CommandEntry {
  command: string;
  title: string;
  category?: string;
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  contributes: { commands: CommandEntry[]; keybindings?: unknown };
};

const englishTitles = JSON.parse(
  readFileSync(new URL('../package.nls.json', import.meta.url), 'utf8'),
) as Record<string, string>;

const chineseTitles = JSON.parse(
  readFileSync(new URL('../package.nls.zh-cn.json', import.meta.url), 'utf8'),
) as Record<string, string>;

/** 解析命令标题的 `%key%` 资源引用（SPEC-CMD-02）；键缺失时返回空串，让断言直接失败可读。 */
function resolveTitle(commandId: string, table: Record<string, string>): string {
  const entry = manifest.contributes.commands.find((command) => command.command === commandId);
  const key = /^%(.+)%$/.exec(entry?.title ?? '')?.[1];
  return key === undefined ? '' : (table[key] ?? '');
}

describe('命令与入口（SPEC-CMD 域）', () => {
  it('[SPEC-CMD-02] 命令分组为 "ABC Desk"、不新增默认组合键，起播命令标题以括注标明位置来源', () => {
    for (const command of manifest.contributes.commands) {
      expect(command.category).toBe('ABC Desk');
    }
    expect(manifest.contributes.keybindings).toBeUndefined();
    // 起播命令标题消歧（见 docs/decisions.md）：源码 / 预览括注且中英同步
    expect(resolveTitle('abcdesk.playFromCursor', englishTitles)).toBe('Play from Cursor (Source)');
    expect(resolveTitle('abcdesk.playFromCursor', chineseTitles)).toBe('从光标播放（源码）');
    expect(resolveTitle('abcdesk.playFromSelectedNote', englishTitles)).toBe(
      'Play from Selected Note (Preview)',
    );
    expect(resolveTitle('abcdesk.playFromSelectedNote', chineseTitles)).toBe('从所选音符播放（预览）');
  });
  it.todo('[SPEC-CMD-03] 同文件复用已有预览不重复创建、只显示不新起播（运行时行为）');
  it.todo('[SPEC-CMD-07] 播放与从光标播放可按需打开预览并保留源码焦点，停止不新建预览');
  it.todo('[SPEC-CMD-08] 从光标播放与从所选音符播放上下文分离，不做跨源回退');
  it.todo('[SPEC-CMD-09] 播放／暂停控制当前曲目不跟随光标，准备中执行取消起播');
  it.todo('[SPEC-CMD-10] 停止与取消始终可达，不因音频未就绪或内容错误失效');
  it.todo('[SPEC-CMD-11] 命令与预览按钮共用操作规则，启用条件与执行校验分离');
  it.todo('[SPEC-CMD-12] 转到源码编辑只打开来源文件，无映射不套用旧偏移，来源标签关闭后按 URI 重新打开');
  it.todo('[SPEC-CMD-13] 导出使用执行时文档快照，多曲目每次确认一首');
  it.todo('[SPEC-CMD-14] 迁移来源状态页不再是可控音乐目标');
});
