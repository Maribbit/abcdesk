import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 示范绑定：测试标题以 [SPEC-域-序号] 前置，由 scripts/spec-check.mjs 双向校验。
// 规格正文见 docs/spec/cmd.md 与 docs/spec/set.md。

interface CommandContribution {
  command: string;
  title: string;
  category?: string;
  icon?: string;
}

interface MenuContribution {
  command: string;
  when?: string;
  group?: string;
}

interface SettingSchema {
  type: string;
  default?: unknown;
}

interface PackageManifest {
  contributes: {
    commands: CommandContribution[];
    configuration: {
      properties: Record<string, SettingSchema>;
    };
    languages: Array<{ id: string; extensions: string[] }>;
    menus: Record<string, MenuContribution[]>;
  };
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

const EXPECTED_COMMAND_IDS = [
  'abcdesk.openPreviewToSide',
  'abcdesk.togglePlayback',
  'abcdesk.stop',
  'abcdesk.playFromCursor',
  'abcdesk.playFromSelectedNote',
  'abcdesk.goToSource',
  'abcdesk.exportMidi',
  'abcdesk.exportSvg',
].sort();

describe('package.json manifest', () => {
  it('[SPEC-CMD-01] 公开命令恰为八个，ID 集合固定且以 abcdesk. 为前缀', () => {
    const ids = manifest.contributes.commands.map((command) => command.command);

    expect(ids).toHaveLength(8);
    expect([...ids].sort()).toEqual(EXPECTED_COMMAND_IDS);
    for (const id of ids) {
      expect(id.startsWith('abcdesk.')).toBe(true);
    }
  });

  it('[SPEC-SET-01] 首版唯一设置为布尔 abcdesk.rememberPracticeSettings，默认 true', () => {
    const properties = manifest.contributes.configuration.properties;

    expect(Object.keys(properties)).toEqual(['abcdesk.rememberPracticeSettings']);
    expect(properties['abcdesk.rememberPracticeSettings']).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  it('[SPEC-CMD-03] 打开预览的编辑器标题栏与资源管理器入口共用同一命令', () => {
    const menus = manifest.contributes.menus;

    expect(menus['editor/title']).toHaveLength(1);
    expect(menus['editor/title'][0]).toMatchObject({
      command: 'abcdesk.openPreviewToSide',
      when: 'resourceLangId == abc',
    });
    expect(menus['explorer/context']).toHaveLength(1);
    expect(menus['explorer/context'][0]).toMatchObject({
      command: 'abcdesk.openPreviewToSide',
      when: 'resourceExtname == .abc',
    });
  });

  it('[SPEC-CMD-15] 编辑器标题栏预览入口以内置图标按钮呈现', () => {
    const openPreview = manifest.contributes.commands.find(
      (command) => command.command === 'abcdesk.openPreviewToSide',
    );

    expect(openPreview?.icon).toBe('$(open-preview)');
  });

  it('[SPEC-CMD-16] .abc 编辑器右键菜单提供从光标播放入口，与命令面板共用同一命令', () => {
    const menus = manifest.contributes.menus;

    expect(menus['editor/context']).toHaveLength(1);
    expect(menus['editor/context'][0]).toMatchObject({
      command: 'abcdesk.playFromCursor',
      when: 'resourceLangId == abc',
      group: 'navigation',
    });
  });

  it('[SPEC-ENV-10] contributes.languages 声明 abc 语言与 .abc 扩展名', () => {
    expect(manifest.contributes.languages).toContainEqual({
      id: 'abc',
      extensions: ['.abc'],
    });
  });
});
