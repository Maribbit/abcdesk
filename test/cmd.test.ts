import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Skeleton-stage placeholders: the CMD domain is fully distilled (docs/spec/cmd.md); each is replaced with real assertions as the behavior is implemented.
// it.todo also counts as a bound reference for spec-check (see scripts/spec-check.mjs).

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

/** Resolve a command title's `%key%` resource reference (SPEC-CMD-02); a missing key returns an empty string so the assertion fails readably. */
function resolveTitle(commandId: string, table: Record<string, string>): string {
  const entry = manifest.contributes.commands.find((command) => command.command === commandId);
  const key = /^%(.+)%$/.exec(entry?.title ?? '')?.[1];
  return key === undefined ? '' : (table[key] ?? '');
}

describe('commands and entry points (SPEC-CMD domain)', () => {
  it('[SPEC-CMD-02] commands are grouped under "ABC Desk" with no default keybindings, and start-command titles mark the position source in parentheses', () => {
    for (const command of manifest.contributes.commands) {
      expect(command.category).toBe('ABC Desk');
    }
    expect(manifest.contributes.keybindings).toBeUndefined();
    // Start-command title disambiguation (see docs/decisions.md): source / preview in parentheses, kept in sync between English and Chinese
    expect(resolveTitle('abcdesk.playFromCursor', englishTitles)).toBe('Play from Cursor (Source)');
    expect(resolveTitle('abcdesk.playFromCursor', chineseTitles)).toBe('从光标播放（源码）');
    expect(resolveTitle('abcdesk.playFromSelectedNote', englishTitles)).toBe(
      'Play from Selected Note (Preview)',
    );
    expect(resolveTitle('abcdesk.playFromSelectedNote', chineseTitles)).toBe('从所选音符播放（预览）');
  });
  it.todo('[SPEC-CMD-03] the same file reuses its existing preview without creating another, reveal only, no new playback (runtime behavior)');
  it.todo('[SPEC-CMD-07] play and play-from-cursor may open the preview on demand while keeping source focus; stop never creates a preview');
  it.todo('[SPEC-CMD-08] play-from-cursor takes the cursor at execution time, play-from-selected-note takes the preview target; independent entries with no implicit fallback');
  it.todo('[SPEC-CMD-09] play/pause controls the current tune without following the cursor; while preparing it cancels the start');
  it.todo('[SPEC-CMD-10] stop and cancel are always reachable and do not fail because audio is not ready or the content is invalid');
  it.todo('[SPEC-CMD-11] commands and preview buttons share operation rules; enablement and execution validation are separate');
  it.todo('[SPEC-CMD-12] go-to-source only opens the source file, does not reuse an old offset without a mapping, and reopens by URI after the source tab closed');
  it.todo('[SPEC-CMD-13] exports use the document snapshot at execution time; multi-tune files confirm one tune per export');
  it.todo('[SPEC-CMD-14] a migrated source status page is no longer a controllable music target');
});
