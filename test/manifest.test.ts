import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 示范绑定：测试标题以 [SPEC-域-序号] 前置，由 scripts/spec-check.mjs 双向校验。
// 规格正文见 docs/spec/cmd.md 与 docs/spec/set.md。

interface CommandContribution {
  command: string;
  title: string;
  category?: string;
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
});
