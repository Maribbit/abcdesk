import { describe, expect, it } from 'vitest';
import { choosePreviewTarget, isAbcTarget, type TargetCandidate } from '../src/core/target';

// Bindings in docs/spec/cmd.md (CMD-04 / 05 / 06); titles are prefixed with [SPEC-domain-number] and checked both ways by scripts/spec-check.mjs.

function candidate(overrides: Partial<TargetCandidate>): TargetCandidate {
  return {
    uri: 'file:///workspace/song.abc',
    languageId: 'abc',
    isUntitled: false,
    ...overrides,
  };
}

describe('target resolution (SPEC-CMD domain)', () => {
  it('[SPEC-CMD-04] an explicit target wins and an invalid one does not fall back; the active context is used only without an explicit target', () => {
    const explicit = candidate({ uri: 'file:///workspace/explicit.abc' });
    const active = candidate({ uri: 'file:///workspace/active.abc' });

    // Explicit target wins
    expect(choosePreviewTarget(explicit, active)?.uri).toBe(explicit.uri);

    // An invalid explicit target returns undefined without falling back to the active context
    const invalid = candidate({ uri: 'file:///workspace/notes.md', languageId: 'markdown' });
    expect(choosePreviewTarget(invalid, active)).toBeUndefined();

    // Without an explicit target the active context from before the call is used
    expect(choosePreviewTarget(undefined, active)?.uri).toBe(active.uri);
    expect(choosePreviewTarget(undefined, undefined)).toBeUndefined();
  });

  it('[SPEC-CMD-04] same name under different paths is distinguished by document identity', () => {
    const left = candidate({ uri: 'file:///left/song.abc' });
    const right = candidate({ uri: 'file:///right/song.abc' });

    expect(choosePreviewTarget(undefined, left)?.uri).toBe('file:///left/song.abc');
    expect(choosePreviewTarget(undefined, right)?.uri).toBe('file:///right/song.abc');
  });

  it('[SPEC-CMD-05] no valid target returns undefined and produces no fallback target', () => {
    // Learning notes, other languages, no editor: none is a target
    expect(
      choosePreviewTarget(
        undefined,
        candidate({ uri: 'file:///workspace/practice.md', languageId: 'markdown' }),
      ),
    ).toBeUndefined();
    expect(
      choosePreviewTarget(undefined, candidate({ uri: 'file:///workspace/melody.txt', languageId: 'plaintext' })),
    ).toBeUndefined();
    expect(choosePreviewTarget(undefined, undefined)).toBeUndefined();
  });

  it('[SPEC-CMD-06] an unsaved new ABC document is a valid target', () => {
    const untitled = candidate({ uri: 'untitled:Untitled-1', languageId: 'abc', isUntitled: true });

    expect(isAbcTarget(untitled)).toBe(true);
    expect(choosePreviewTarget(untitled, undefined)?.uri).toBe('untitled:Untitled-1');

    // An unsaved document in a non-abc language is not a target
    expect(isAbcTarget({ uri: 'untitled:Untitled-2', languageId: 'plaintext', isUntitled: true })).toBe(false);
    // The extension check is case-insensitive
    expect(isAbcTarget(candidate({ uri: 'file:///workspace/SONG.ABC', languageId: 'plaintext' }))).toBe(true);
  });
});
