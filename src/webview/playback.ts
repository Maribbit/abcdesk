/**
 * 播放控件的纯逻辑（SPEC-PLAY-04 / 05 / 06、SPEC-ENV-07）：速度换算与解析、时间显示、
 * 声部清单与和弦轨识别、带拍换算提示、演奏视图的乐器统一。
 *
 * 全部为纯函数与结构类型（不 import abcjs 运行时，与 keyboard.ts 同先例），
 * 由 test/playback.test.ts 真实覆盖；PLAY 域为 manual 验证（登记见 docs/manual-checks.md），
 * 测试标题额外引用条目以便双向校验。
 */

import type { AudioTracks, SynthOptions, TuneObject } from 'abcjs';

/** 速度百分比范围、步进与默认值（SPEC-PLAY-04：默认 100%、范围 25%～200%）。 */
export const SPEED_MIN = 25;
export const SPEED_MAX = 200;
export const SPEED_DEFAULT = 100;
export const SPEED_STEP = 5;

/** 规整速度为合法值（SPEC-PLAY-04）：四舍五入取整并夹取到范围；非数值回退默认。 */
export function clampSpeed(percent: number): number {
  if (!Number.isFinite(percent)) {
    return SPEED_DEFAULT;
  }
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(percent)));
}

/**
 * 解析速度输入（SPEC-PLAY-04 / P06 口径）：空值与非法数字返回 null（由调用方还原当前值）；
 * 越界数值夹取到范围（不判非法）。
 */
export function parseSpeedPercent(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return null;
  }
  return clampSpeed(value);
}

/** 毫秒 → "M:SS"（进度条时间标签，SPEC-PLAY-05）；负值与非有限值按 0 处理。 */
export function formatClock(milliseconds: number): string {
  const safe = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 声部清单条目（SPEC-PLAY-06）：index 为演奏时序中的声部序号；name 为空表示无声部名。 */
export interface VoiceEntry {
  index: number;
  name: string | null;
}

/** 声部清单所需的最小曲目结构（abcjs TuneObject 的子集）。 */
export interface VoiceStaffView {
  clef?: { type?: string };
  voices?: ReadonlyArray<unknown>;
  title?: ReadonlyArray<string | undefined>;
}

export interface VoiceLineView {
  staff?: ReadonlyArray<VoiceStaffView>;
}

export interface VoiceSource {
  lines?: ReadonlyArray<VoiceLineView>;
}

/**
 * 收集曲目的实际声部清单（SPEC-PLAY-06：展示 ABC 实际声部，不强制第一声部为示范）。
 * 计数镜像 abcjs sequencer：逐行归零、跳过 TAB 谱表、谱表内按 voices 顺序、跨行取最大；
 * 名称取该声部首个非空 staff.title（abcjs 已在 fixTitles 后转为字符串数组），无名回退 null。
 */
export function collectVoices(tune: VoiceSource): VoiceEntry[] {
  const names: Array<string | null> = [];
  for (const line of tune.lines ?? []) {
    let voiceNumber = 0;
    for (const staff of line.staff ?? []) {
      if (staff.clef?.type === 'TAB') {
        continue;
      }
      const voices = staff.voices ?? [];
      for (let withinStaff = 0; withinStaff < voices.length; withinStaff += 1) {
        const title = staff.title?.[withinStaff];
        if (names[voiceNumber] === undefined || names[voiceNumber] === null) {
          names[voiceNumber] = typeof title === 'string' && title !== '' ? title : null;
        }
        voiceNumber += 1;
      }
    }
  }
  return names.map((name, index) => ({ index, name }));
}

/**
 * SPEC-SET-04：用音符在解析输入中的位置核验 V: 归属，不将显示名或轨序号当作标识。
 * abcjs 不公开原 V: id；不完整、矛盾或无法核验的轨一律返回未知。
 */
export function voiceSignature(tune: TuneObject, abc: string): string | null {
  // 先掩蔽文本块和非声部字段，再过滤注释、字符串、装饰；始终保留 UTF-16 长度和行界。
  let block: string | undefined;
  const source = abc.split('\n').map((line) => {
    const begin = /^%%begin(\w+)/i.exec(line);
    const end = /^%%end(\w+)/i.exec(line);
    const blocked = block !== undefined || begin !== null;
    if (begin !== null) block = begin[1].toLowerCase();
    if (end !== null && end[1].toLowerCase() === block) block = undefined;
    return blocked || /^(?!V:|K:)[A-Za-z+]:/.test(line) ? ' '.repeat(line.length) : line;
  }).join('\n');
  let masked = '';
  let quote = '';
  let comment = false;
  for (let index = 0; index < abc.length; index += 1) {
    const char = source[index];
    if (char === '\n') { comment = false; quote = ''; masked += char; continue; }
    if (comment) { masked += ' '; continue; }
    if (quote !== '') {
      if (char === quote && abc[index - 1] !== '\\') quote = '';
      masked += ' ';
      continue;
    }
    if (char === '%' && abc[index - 1] !== '\\') { comment = true; masked += ' '; continue; }
    if (char === '"' || char === '!' || char === '+') { quote = char; masked += ' '; continue; }
    masked += char;
  }
  const headerEnd = /^K:.*$/m.exec(masked);
  const bodyStart = headerEnd === null ? 0 : headerEnd.index + headerEnd[0].length;
  const declarations = [...masked.matchAll(/(?:^|\n)V:[ \t]*([^\s[\]%]+)|\[V:[ \t]*([^\s\]]+)/g)];
  const declared = new Set(declarations.map((match) => match[1] ?? match[2]));
  const switches = declarations.filter((match) => match.index >= bodyStart || match[2] !== undefined);
  const entries = collectVoices(tune);
  const ids: Array<string | undefined> = [];
  for (const line of tune.lines) {
    let track = 0;
    for (const staff of line.staff ?? []) {
      if ((staff.clef as { type?: string } | undefined)?.type === 'TAB') continue;
      for (const voice of staff.voices ?? []) {
        for (const note of voice ?? []) {
          if (note.el_type !== 'note' || note.startChar === undefined || note.startChar < 0) continue;
          let id = declared.size === 0 ? '@implicit' : declared.size === 1 ? [...declared][0] : undefined;
          for (const change of switches) {
            if (change.index > note.startChar) break;
            id = change[1] ?? change[2];
          }
          if (id === undefined || (ids[track] !== undefined && ids[track] !== id)) return null;
          ids[track] = id;
        }
        track += 1;
      }
    }
  }
  if (entries.length === 0 || entries.some((entry) => ids[entry.index] === undefined)) return null;
  if (new Set(ids).size !== entries.length || [...declared].some((id) => !ids.includes(id))) return null;
  // null 是内部默认声部标识，与任何显式 V: 字符串均不冲突。
  return JSON.stringify(entries.map((entry) => [declared.size === 0 ? null : ids[entry.index], entry.name]));
}

/**
 * 是否含自动和弦伴奏轨（SPEC-PLAY-06 / 10）：abcjs 的和弦轨 channel 为声部数本身
 * （鼓轨为声部数 + 1，见 abcjs ChordTrack / writeDrum）；首条 program 指令即该轨标识。
 * 检测须用无静音参数的展开产物（chordsOff 时完全无轨），无该轨时菜单不显示和弦开关。
 */
export function hasChordTrack(tracks: unknown, voiceCount: number): boolean {
  if (!Array.isArray(tracks)) {
    return false;
  }
  for (let index = voiceCount; index < tracks.length; index += 1) {
    const track: unknown = tracks[index];
    if (!Array.isArray(track)) {
      continue;
    }
    for (const item of track) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const event = item as { cmd?: unknown; channel?: unknown };
      if (event.cmd !== 'program') {
        continue;
      }
      if (event.channel === voiceCount) {
        return true;
      }
      break; // 该轨首条 program 不是和弦轨标识：后续 program 只做乐器切换，不是和弦轨
    }
  }
  return false;
}

/** 带拍提示所需的最小曲目结构（abcjs TuneObject 的子集）。 */
export interface BeatHintSource {
  getBeatLength: () => number;
  getBpm: () => number;
  /** abcjs 运行时属性：按小节号索引的曲中速度位置（0 = 曲首 Q:）；类型声明未公开，按 unknown 读取。 */
  tempoLocations?: unknown;
}

/**
 * 带拍换算提示（SPEC-PLAY-04）：可可靠换算时返回"四分音符每分钟数"，否则 null（不显示猜测值）。
 * 仅在四分音符为一拍（beatLength = 0.25）且除曲首外无速度变更时给出；
 * getBpm 已把 Q: 的拍单位声明换算到拍上，这里只需按速度百分比缩放。
 */
export function beatHintFor(tune: BeatHintSource, speedPercent: number): number | null {
  if (tune.getBeatLength() !== 0.25) {
    return null;
  }
  const locations = tune.tempoLocations;
  if (typeof locations !== 'object' || locations === null) {
    return null;
  }
  for (const key of Object.keys(locations)) {
    if (Number(key) > 0) {
      return null; // 曲中变速：单一提示值无法表达，按所在位置解释
    }
  }
  return Math.round((tune.getBpm() * speedPercent) / 100);
}

/** 钢琴在 General MIDI 乐器表中的编号（abcjs 展开产物按数字索引；0 即 acoustic_grand_piano）。 */
const PIANO_PROGRAM = 0;

/**
 * 仅钢琴的播放视图（SPEC-ENV-07）：包装出以原曲目为原型的副本，只覆盖 setUpAudio，
 * 把展开产物的乐器指令（program / note 事件的 instrument）统一为钢琴。
 *
 * 为什么在展开产物上统一：合成器的音色样本请求发生在 init 内部、按展开产物的 instrument
 * 归组（早于 sequenceCallback 与缓冲生成），只改音序映射会造成"请求集合与实际放置"错配——
 * 材料中的非钢琴指令（如 %%MIDI program 73）会请求本地不存在的音色目录、并在放置时被静默跳过。
 * 为什么不改原曲目：MIDI 导出要求保留材料中的乐器指令（SPEC-EXP-05），原对象须保持原样；
 * 视图其余方法（拍号 / 弱起 / 拍数等）经原型链沿用原对象。
 */
export function pianoOnlyTuneView<T extends { setUpAudio: (options: SynthOptions) => AudioTracks }>(
  tune: T,
): T {
  const view = Object.create(tune) as T;
  const originalSetUpAudio = tune.setUpAudio;
  // 原展开方法经 this 读取曲目（formatting / lines），必须以原对象为 this 调用
  view.setUpAudio = (options: SynthOptions): AudioTracks => {
    const flattened = originalSetUpAudio.call(tune, options);
    for (const track of flattened.tracks) {
      for (const item of track) {
        if ('instrument' in item) {
          item.instrument = PIANO_PROGRAM;
        }
      }
    }
    return flattened;
  };
  return view;
}
