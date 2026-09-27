import { describe, expect, it } from 'vitest';
import {
  MIDDLE_C_PITCH,
  MIN_SPAN_SEMITONES,
  MIN_WHITE_KEY_WIDTH,
  PIANO_MAX_PITCH,
  PIANO_MIN_PITCH,
  collectPitches,
  computeKeyMetrics,
  computeTuneRange,
  isBlackKey,
  keyPitches,
  outOfRangePitches,
  pitchName,
} from '../src/webview/keyboard';

// 绑定见 docs/spec/play.md（PLAY-08 音域与展开、PLAY-09 提示语义、STATE-05 全休止符）；
// 标题以 [SPEC-域-序号] 前置，由 scripts/spec-check.mjs 双向校验。

describe('键盘音域算法（SPEC-PLAY-08）', () => {
  it('[SPEC-PLAY-08] 材料音高去重排序，忽略缺失音高', () => {
    const pitches = collectPitches([
      { midiPitches: [{ pitch: 64 }, { pitch: 60 }] },
      { midiPitches: [{ pitch: 64 }, {}] },
      {},
      { midiPitches: [{ pitch: 67 }] },
    ]);

    expect(pitches).toEqual([60, 64, 67]);
  });

  it('[SPEC-PLAY-08] 宽音域材料原样保留，窄音域居中扩至至少两个八度', () => {
    // 恰好两个八度：不扩
    expect(computeTuneRange([60, 84])).toEqual({ start: 60, end: 84 });

    // 窄音域：居中扩展，跨度达到两八度且仍覆盖材料
    const narrow = computeTuneRange([60, 64]);
    expect(narrow.end - narrow.start).toBe(MIN_SPAN_SEMITONES);
    expect(narrow.start).toBeLessThanOrEqual(60);
    expect(narrow.end).toBeGreaterThanOrEqual(64);
    expect((narrow.start + narrow.end) / 2).toBe((60 + 64) / 2);
  });

  it('[SPEC-PLAY-08] 贴边音域夹取到 A0–C8 后仍保持至少两个八度', () => {
    const low = computeTuneRange([PIANO_MIN_PITCH]);
    expect(low.start).toBe(PIANO_MIN_PITCH);
    expect(low.end - low.start).toBe(MIN_SPAN_SEMITONES);

    const high = computeTuneRange([PIANO_MAX_PITCH]);
    expect(high.end).toBe(PIANO_MAX_PITCH);
    expect(high.end - high.start).toBe(MIN_SPAN_SEMITONES);
  });

  it('[SPEC-PLAY-08] 超出 A0–C8 的音不参与音域区间（由说明行单独提示，不折返）', () => {
    const range = computeTuneRange([10, 30, 50]);
    expect(range.start).toBeGreaterThanOrEqual(PIANO_MIN_PITCH);
    expect(range.end).toBeLessThanOrEqual(PIANO_MAX_PITCH);
    expect(range.end - range.start).toBeGreaterThanOrEqual(MIN_SPAN_SEMITONES);

    expect(outOfRangePitches([20, PIANO_MIN_PITCH, 60, PIANO_MAX_PITCH, 109])).toEqual([20, 109]);
    expect(outOfRangePitches([21, 60, 108])).toEqual([]);
  });

  it('[SPEC-PLAY-08][SPEC-STATE-05] 无音高材料返回默认两八度参照音域', () => {
    const range = computeTuneRange([]);
    expect(range.end - range.start).toBe(MIN_SPAN_SEMITONES);
    // 默认参照音域围绕中央 C（全休止符材料仍显示参照空间并说明没有可提示音高）
    expect(range.start).toBeLessThanOrEqual(MIDDLE_C_PITCH);
    expect(range.end).toBeGreaterThanOrEqual(MIDDLE_C_PITCH);
  });

  it('[SPEC-PLAY-08] 完整 88 键模式固定 A0–C8，乐曲模式按计算音域', () => {
    const tuneRange = computeTuneRange([60, 64]);
    const tuneKeys = keyPitches('tune', tuneRange);
    expect(tuneKeys[0]).toBe(tuneRange.start);
    expect(tuneKeys[tuneKeys.length - 1]).toBe(tuneRange.end);

    const fullKeys = keyPitches('full', tuneRange);
    expect(fullKeys).toHaveLength(88);
    expect(fullKeys[0]).toBe(PIANO_MIN_PITCH);
    expect(fullKeys[fullKeys.length - 1]).toBe(PIANO_MAX_PITCH);
  });

  it('[SPEC-PLAY-08] 音名标记各 C 的八度，中央 C 标为 C4', () => {
    expect(pitchName(PIANO_MIN_PITCH)).toBe('A0');
    expect(pitchName(MIDDLE_C_PITCH)).toBe('C4');
    expect(pitchName(61)).toBe('C#4');
    expect(pitchName(PIANO_MAX_PITCH)).toBe('C8');
  });

  it('[SPEC-PLAY-08] 黑白键布局按 12 平均律', () => {
    // 白键：C D E F G A B
    for (const pitch of [60, 62, 64, 65, 67, 69, 71]) {
      expect(isBlackKey(pitch)).toBe(false);
    }
    // 黑键：C# D# F# G# A#
    for (const pitch of [61, 63, 66, 68, 70]) {
      expect(isBlackKey(pitch)).toBe(true);
    }
  });

  it('[SPEC-PLAY-08] 键尺寸保底最小键宽，放不下宁横滚不压缩；高度有上下限', () => {
    // 窄容器：白键宽保底（88 键也保持可辨认）
    const narrow = computeKeyMetrics(200, 52);
    expect(narrow.whiteWidth).toBe(MIN_WHITE_KEY_WIDTH);
    expect(narrow.blackWidth).toBeCloseTo(MIN_WHITE_KEY_WIDTH * 0.6);
    expect(narrow.blackOffset).toBeCloseTo(-narrow.blackWidth / 2);

    // 零宽（隐藏 / 未布局）：同样保底，不产生非法尺寸
    expect(computeKeyMetrics(0, 15).whiteWidth).toBe(MIN_WHITE_KEY_WIDTH);

    // 宽容器：白键摊开，高度按比例并受上限约束
    const wide = computeKeyMetrics(1600, 15);
    expect(wide.whiteWidth).toBeGreaterThan(MIN_WHITE_KEY_WIDTH);
    expect(wide.whiteHeight).toBeLessThanOrEqual(96);
    expect(wide.whiteHeight).toBeGreaterThanOrEqual(52);
    expect(wide.blackHeight).toBeLessThan(wide.whiteHeight);
  });
});
