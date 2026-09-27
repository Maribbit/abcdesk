/**
 * 播放控件的纯逻辑（SPEC-PLAY-04 / 05 / 06）：速度换算与解析、时间显示、
 * 声部清单与和弦轨识别、带拍换算提示。
 *
 * 全部为纯函数与结构类型（不 import abcjs 运行时，与 keyboard.ts 同先例），
 * 由 test/playback.test.ts 真实覆盖；PLAY 域为 manual 验证（登记见 docs/manual-checks.md），
 * 测试标题额外引用条目以便双向校验。
 */

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
