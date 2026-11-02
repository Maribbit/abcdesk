import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Example binding: test titles are prefixed with [SPEC-domain-number] and checked both ways by scripts/spec-check.mjs.
// Spec text in docs/spec/cmd.md and docs/spec/set.md.

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
  it('[SPEC-CMD-01] exactly eight public commands, with a fixed ID set prefixed abcdesk.', () => {
    const ids = manifest.contributes.commands.map((command) => command.command);

    expect(ids).toHaveLength(8);
    expect([...ids].sort()).toEqual(EXPECTED_COMMAND_IDS);
    for (const id of ids) {
      expect(id.startsWith('abcdesk.')).toBe(true);
    }
  });

  it('[SPEC-SET-01] the only setting in the first version is the boolean abcdesk.rememberPracticeSettings, default true', () => {
    const properties = manifest.contributes.configuration.properties;

    expect(Object.keys(properties)).toEqual(['abcdesk.rememberPracticeSettings']);
    expect(properties['abcdesk.rememberPracticeSettings']).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  it('[SPEC-CMD-03] the editor title bar and explorer entries for opening the preview share one command', () => {
    const menus = manifest.contributes.menus;

    const titleEntries = menus['editor/title'].filter(
      (entry) => entry.command === 'abcdesk.openPreviewToSide',
    );
    expect(titleEntries).toHaveLength(1);
    expect(titleEntries[0]).toMatchObject({
      command: 'abcdesk.openPreviewToSide',
      when: 'resourceLangId == abc',
    });
    expect(menus['explorer/context']).toHaveLength(1);
    expect(menus['explorer/context'][0]).toMatchObject({
      command: 'abcdesk.openPreviewToSide',
      when: 'resourceExtname == .abc',
    });
  });

  it('[SPEC-CMD-15] the editor title bar preview entry is shown as a built-in icon button', () => {
    const openPreview = manifest.contributes.commands.find(
      (command) => command.command === 'abcdesk.openPreviewToSide',
    );

    expect(openPreview?.icon).toBe('$(open-preview)');
  });

  it('[SPEC-CMD-16] the .abc editor context menu offers play-from-cursor, sharing one command with the command palette', () => {
    const menus = manifest.contributes.menus;

    expect(menus['editor/context']).toHaveLength(1);
    expect(menus['editor/context'][0]).toMatchObject({
      command: 'abcdesk.playFromCursor',
      when: 'resourceLangId == abc',
      group: 'navigation',
    });
  });

  it('[SPEC-CMD-17] the preview panel title bar offers a go-to-source icon button, sharing one command with the command palette', () => {
    const menus = manifest.contributes.menus;
    const goToSource = manifest.contributes.commands.find(
      (command) => command.command === 'abcdesk.goToSource',
    );

    const gotoEntries = menus['editor/title'].filter(
      (entry) => entry.command === 'abcdesk.goToSource',
    );
    expect(gotoEntries).toHaveLength(1);
    expect(gotoEntries[0]).toMatchObject({
      command: 'abcdesk.goToSource',
      when: 'activeWebviewPanelId == abcdesk.preview',
      group: 'navigation',
    });
    expect(goToSource?.icon).toBe('$(go-to-file)');
  });

  it('[SPEC-ENV-10] contributes.languages declares the abc language with the .abc extension', () => {
    expect(manifest.contributes.languages).toContainEqual({
      id: 'abc',
      extensions: ['.abc'],
    });
  });
});
