/**
 * MIDI 导出（SPEC-EXP-05）：按 ABC 原材料生成标准 MIDI 文件，
 * 不应用播放器练习设置（速度百分比、声部静音、循环等），也不做音频采样合成。
 */
import { loadAbcjs } from './abcjs';
import { tuneHasNotes } from './tunes';

/** 导出单曲 MIDI（SPEC-EXP-05）；无音符内容时返回 undefined，不生成空文件（SPEC-EXP-08）。 */
export async function generateMidiBytes(abcText: string): Promise<Uint8Array | undefined> {
  const abcjs = await loadAbcjs();
  const tunes = abcjs.parseOnly(abcText);
  const tune = tunes[0];
  if (tune === undefined || !tuneHasNotes(tune)) {
    return undefined;
  }
  const result: unknown = abcjs.synth.getMidiFile(tune, { midiOutputType: 'binary' });
  if (result instanceof Uint8Array) {
    return result;
  }
  // 防御 abcjs 版本差异：按字符串来源返回时是各曲目字节数组
  if (Array.isArray(result) && result[0] instanceof Uint8Array) {
    return result[0];
  }
  throw new Error('abcjs did not return binary MIDI data');
}
