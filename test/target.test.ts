import { describe, expect, it } from 'vitest';
import { choosePreviewTarget, isAbcTarget, type TargetCandidate } from '../src/core/target';

// 绑定见 docs/spec/cmd.md（CMD-04 / 05 / 06）；标题以 [SPEC-域-序号] 前置，由 scripts/spec-check.mjs 双向校验。

function candidate(overrides: Partial<TargetCandidate>): TargetCandidate {
  return {
    uri: 'file:///workspace/song.abc',
    languageId: 'abc',
    isUntitled: false,
    ...overrides,
  };
}

describe('目标解析（SPEC-CMD 域）', () => {
  it('[SPEC-CMD-04] 明确目标优先且无效不回退，无显式目标时才用活动上下文', () => {
    const explicit = candidate({ uri: 'file:///workspace/explicit.abc' });
    const active = candidate({ uri: 'file:///workspace/active.abc' });

    // 明确目标优先
    expect(choosePreviewTarget(explicit, active)?.uri).toBe(explicit.uri);

    // 明确目标无效时返回 undefined，不回退到活动上下文
    const invalid = candidate({ uri: 'file:///workspace/notes.md', languageId: 'markdown' });
    expect(choosePreviewTarget(invalid, active)).toBeUndefined();

    // 无显式目标时使用调用前的活动上下文
    expect(choosePreviewTarget(undefined, active)?.uri).toBe(active.uri);
    expect(choosePreviewTarget(undefined, undefined)).toBeUndefined();
  });

  it('[SPEC-CMD-04] 同名不同路径按文档标识区分', () => {
    const left = candidate({ uri: 'file:///left/song.abc' });
    const right = candidate({ uri: 'file:///right/song.abc' });

    expect(choosePreviewTarget(undefined, left)?.uri).toBe('file:///left/song.abc');
    expect(choosePreviewTarget(undefined, right)?.uri).toBe('file:///right/song.abc');
  });

  it('[SPEC-CMD-05] 无有效目标返回 undefined，不产生回退目标', () => {
    // 学习记录、其他语言、无编辑器：都不是目标
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

  it('[SPEC-CMD-06] 未保存 ABC 新文档是有效目标', () => {
    const untitled = candidate({ uri: 'untitled:Untitled-1', languageId: 'abc', isUntitled: true });

    expect(isAbcTarget(untitled)).toBe(true);
    expect(choosePreviewTarget(untitled, undefined)?.uri).toBe('untitled:Untitled-1');

    // 非 abc 语言的未保存文档不是目标
    expect(isAbcTarget({ uri: 'untitled:Untitled-2', languageId: 'plaintext', isUntitled: true })).toBe(false);
    // 扩展名判断不区分大小写
    expect(isAbcTarget(candidate({ uri: 'file:///workspace/SONG.ABC', languageId: 'plaintext' }))).toBe(true);
  });
});
