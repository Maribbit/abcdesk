import { t } from './l10n';

/**
 * 钢琴键盘可视化（SPEC-PLAY-08 / 09 / 15、SPEC-STATE-03 / 05）与音域算法。
 *
 * - 音域算法（computeTuneRange / keyPitches / computeKeyMetrics 等）为纯函数，
 *   由 test/keyboard.test.ts 真实覆盖（SPEC-PLAY-08）；视图类 KeyboardView 只做 DOM；
 * - 键盘纯可视（SPEC-PLAY-09）：琴键不进入 Tab 顺序、不提供点击试听、不呈现可演奏按钮，
 *   可访问描述由滚动容器承载（SPEC-A11Y-13 / 15）；
 * - 播放高亮经由 setActivePitches 跟随演奏时间，键表内高亮、视口外的提示音只显示方向箭头，
 *   不自动横移、不把手动浏览拉回（SPEC-PLAY-08）；
 * - 查阅 / 点选反射（SPEC-PLAY-15）经 setPointedPitches 以查阅色突出对应琴键，与播放高亮独立，
 *   同一键同时命中时由 CSS 规则让播放色优先。
 */

/** 键盘音域模式（SPEC-PLAY-08 / SET-05）：乐曲 = 当前曲目材料音域，完整 88 键 = A0–C8。 */
export type KeyboardRangeMode = 'tune' | 'full';

/** A0–C8 的 MIDI 音边界（SPEC-PLAY-08）：完整 88 键的可视范围。 */
export const PIANO_MIN_PITCH = 21;
export const PIANO_MAX_PITCH = 108;

/** 中央 C 的 MIDI 音（SPEC-PLAY-08：中央 C 标为 C4；音名按科学音高记法推算）。 */
export const MIDDLE_C_PITCH = 60;

/** 材料音域下限（SPEC-PLAY-08：至少保留两个八度的参照空间）。 */
export const MIN_SPAN_SEMITONES = 24;

/** 白键最小宽度（SPEC-PLAY-08：窄窗口保持可辨认键宽，放不下宁横滚不压缩）。 */
export const MIN_WHITE_KEY_WIDTH = 20;

const MIN_WHITE_KEY_HEIGHT = 52;
const MAX_WHITE_KEY_HEIGHT = 96;
const WHITE_KEY_HEIGHT_RATIO = 3;
const BLACK_KEY_WIDTH_RATIO = 0.6;
const BLACK_KEY_HEIGHT_RATIO = 0.62;
const KEYBOARD_HORIZONTAL_PADDING = 16;

/** 无音高材料（全休止符等）的默认参照音域 C3–C5（SPEC-STATE-05：键盘可说明没有音高提示）。 */
const EMPTY_TUNE_START = 48;
const EMPTY_TUNE_END = 72;

export interface TuneRange {
  start: number;
  end: number;
}

/** 演奏时序事件里可提取的材料音高（结构类型，避免在纯逻辑模块 import abcjs）。 */
export interface PitchCarrier {
  midiPitches?: ReadonlyArray<{ pitch?: number }>;
}

/**
 * 材料音高集合（SPEC-PLAY-08）：当前曲目整首记谱材料去重排序；含静音声部
 * （静音只作用于发声轨，不改变时序事件里的音高），不合并文件内其他曲目。
 */
export function collectPitches(events: ReadonlyArray<PitchCarrier>): number[] {
  const pitches = new Set<number>();
  for (const event of events) {
    for (const midiPitch of event.midiPitches ?? []) {
      if (typeof midiPitch.pitch === 'number') {
        pitches.add(midiPitch.pitch);
      }
    }
  }
  return [...pitches].sort((first, second) => first - second);
}

/**
 * 乐曲模式的音域（SPEC-PLAY-08）：最小～最大音居中扩展至至少两个八度，再夹取到 A0–C8；
 * 无音高材料返回默认两八度参照音域；超出 A0–C8 的音不参与区间（由说明行单独提示、不折返）。
 */
export function computeTuneRange(pitches: ReadonlyArray<number>): TuneRange {
  if (pitches.length === 0) {
    return { start: EMPTY_TUNE_START, end: EMPTY_TUNE_END };
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const pitch of pitches) {
    start = Math.min(start, pitch);
    end = Math.max(end, pitch);
  }
  const deficit = MIN_SPAN_SEMITONES - (end - start);
  if (deficit > 0) {
    const below = Math.floor(deficit / 2);
    start -= below;
    end += deficit - below;
  }
  if (start < PIANO_MIN_PITCH) {
    end += PIANO_MIN_PITCH - start;
    start = PIANO_MIN_PITCH;
  }
  if (end > PIANO_MAX_PITCH) {
    start -= end - PIANO_MAX_PITCH;
    end = PIANO_MAX_PITCH;
  }
  return {
    start: Math.max(start, PIANO_MIN_PITCH),
    end: Math.min(end, PIANO_MAX_PITCH),
  };
}

/** 超出 A0–C8 的音高（SPEC-PLAY-08）：不折返到其他八度，由说明行明确提示。 */
export function outOfRangePitches(pitches: ReadonlyArray<number>): number[] {
  return [...new Set(pitches.filter((pitch) => pitch < PIANO_MIN_PITCH || pitch > PIANO_MAX_PITCH))].sort(
    (first, second) => first - second,
  );
}

/** 当前音域模式的键表（SPEC-PLAY-08）：完整 88 键固定 A0–C8，乐曲模式取计算音域。 */
export function keyPitches(mode: KeyboardRangeMode, tuneRange: TuneRange): number[] {
  const start = mode === 'full' ? PIANO_MIN_PITCH : tuneRange.start;
  const end = mode === 'full' ? PIANO_MAX_PITCH : tuneRange.end;
  const pitches: number[] = [];
  for (let pitch = start; pitch <= end; pitch += 1) {
    pitches.push(pitch);
  }
  return pitches;
}

/** 黑键判据（12 平均律，C 大调钢琴布局）。 */
export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

/** 音名（SPEC-PLAY-08：标记各 C 的八度、中央 C 标为 C4）。 */
export function pitchName(pitch: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(pitch / 12) - 1;
  return `${names[((pitch % 12) + 12) % 12]}${octave}`;
}

export interface KeyMetrics {
  whiteWidth: number;
  whiteHeight: number;
  blackWidth: number;
  blackHeight: number;
  blackOffset: number;
}

/** 键尺寸（SPEC-PLAY-08）：按可视宽度摊白键宽并保底最小宽度（放不下宁横滚不压缩），黑键按比例。 */
export function computeKeyMetrics(availableWidth: number, whiteCount: number): KeyMetrics {
  const usable = Math.max(0, availableWidth - KEYBOARD_HORIZONTAL_PADDING);
  const whiteWidth = Math.max(MIN_WHITE_KEY_WIDTH, usable / Math.max(1, whiteCount));
  const whiteHeight = Math.min(
    MAX_WHITE_KEY_HEIGHT,
    Math.max(MIN_WHITE_KEY_HEIGHT, whiteWidth * WHITE_KEY_HEIGHT_RATIO),
  );
  const blackWidth = whiteWidth * BLACK_KEY_WIDTH_RATIO;
  return {
    whiteWidth,
    whiteHeight,
    blackWidth,
    blackHeight: whiteHeight * BLACK_KEY_HEIGHT_RATIO,
    blackOffset: -blackWidth / 2,
  };
}

/** 键盘视图依赖的 DOM 元素（由 previewPanel 的 HTML 提供；缺失时构造抛出，与 queryElement 同策略）。 */
export interface KeyboardElements {
  section: HTMLElement;
  caption: HTMLElement;
  note: HTMLElement;
  scroll: HTMLElement;
  keys: HTMLElement;
  rangeSelect: HTMLSelectElement;
  collapseButton: HTMLButtonElement;
  leftArrow: HTMLElement;
  rightArrow: HTMLElement;
}

/**
 * 键盘视图（SPEC-PLAY-08 / 09 / 15）：负责键表构建、音域 / 收起两个独立状态、
 * 播放高亮、查阅 / 点选反射与方向箭头；不含音频，不做布局重排通知（低高度由内容整体滚动承接）。
 */
export class KeyboardView {
  private readonly elements: KeyboardElements;
  private readonly keyElements = new Map<number, HTMLElement>();
  /** 音域选择的包裹 label（收起时一并隐藏，dock 条只留说明与展开入口）。 */
  private readonly rangeLabel: HTMLElement | null;

  private mode: KeyboardRangeMode = 'tune';
  /** 手动收起（SPEC-PLAY-08）：同一预览内不因播放或声部切换而展开。 */
  private collapsed = false;
  /** 是否已有可显示的材料（空状态 / 首次渲染失败时整个键盘区隐藏）。 */
  private hasTune = false;
  private tunePitches: number[] = [];
  private tuneRange: TuneRange = { start: EMPTY_TUNE_START, end: EMPTY_TUNE_END };
  private activePitches: number[] = [];
  /** 查阅 / 点选反射（SPEC-PLAY-15）：光标或点选命中的音高，与播放高亮独立。 */
  private pointedPitches: number[] = [];

  constructor(elements: KeyboardElements) {
    this.elements = elements;
    this.rangeLabel = elements.rangeSelect.closest('label');
    this.applyStaticTexts();
    elements.rangeSelect.addEventListener('change', () => this.setMode(readMode(elements.rangeSelect)));
    elements.collapseButton.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    elements.scroll.addEventListener('scroll', () => this.updateArrows());
    // 面板尺寸变化：只重算键尺寸与方向提示，不改变滚动位置（不把手动浏览拉回，SPEC-PLAY-08）
    new ResizeObserver(() => {
      this.refreshSize();
      this.updateArrows();
    }).observe(elements.scroll);
    this.updateVisibility();
  }

  /** 采用新版本的材料音高（SPEC-PLAY-08）：重算音域与键表，动态高亮随新版本重建。 */
  setTune(pitches: ReadonlyArray<number>): void {
    this.tunePitches = [...pitches];
    this.activePitches = [];
    this.hasTune = true;
    this.rebuild();
  }

  /** 清空（空状态 / 无曲目 / 首次渲染失败）：整个键盘区隐藏，不残留旧版本键表与动态 / 反射状态。 */
  clear(): void {
    this.hasTune = false;
    this.activePitches = [];
    this.pointedPitches = [];
    this.tunePitches = [];
    this.keyElements.clear();
    this.elements.keys.replaceChildren();
    this.updateVisibility();
  }

  /**
   * 播放高亮（SPEC-PLAY-09）：跟随记谱材料的演奏时间、包含静音声部；
   * 空数组清除（停止 / 暂停 / 自然结束 / 渲染失败清除动态提示，SPEC-STATE-03）。
   */
  setActivePitches(pitches: ReadonlyArray<number>): void {
    this.activePitches = [...new Set(pitches)];
    this.applyActiveClasses();
    this.updateArrows();
  }

  /** 清空动态提示但保留键表（SPEC-STATE-03：旧谱参考时清除键盘动态提示）。 */
  clearActivePitches(): void {
    this.setActivePitches([]);
  }

  /**
   * 查阅 / 点选反射（SPEC-PLAY-15）：源码光标或预览点选的音符在键盘上以查阅色突出；
   * 与播放高亮独立共存，同一键同时命中时播放色优先（CSS 规则保证）。
   */
  setPointedPitches(pitches: ReadonlyArray<number>): void {
    this.pointedPitches = [...new Set(pitches)];
    this.applyActiveClasses();
  }

  /** 清除查阅 / 点选反射（SPEC-PLAY-15）：标记清除、换版或点到非音符元素时调用。 */
  clearPointedPitches(): void {
    this.setPointedPitches([]);
  }

  private applyStaticTexts(): void {
    const { elements } = this;
    elements.caption.textContent = t('keyboard-caption');
    elements.scroll.setAttribute('aria-label', t('keyboard-region'));
    const labelText = this.rangeLabel === null ? null : this.rangeLabel.querySelector('span');
    if (labelText !== null) {
      labelText.textContent = t('keyboard-range');
    }
    for (const option of Array.from(elements.rangeSelect.options)) {
      option.textContent = t(option.value === 'full' ? 'keyboard-mode-full' : 'keyboard-mode-tune');
    }
    elements.leftArrow.title = t('keyboard-hint-left');
    elements.rightArrow.title = t('keyboard-hint-right');
    this.updateCollapseButton();
  }

  /** 音域模式切换（SPEC-PLAY-08）：立即重建键表并把视图定位到材料音域；不改变收起与提示显隐。 */
  private setMode(mode: KeyboardRangeMode): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    if (this.hasTune) {
      this.rebuild();
    }
  }

  private setCollapsed(collapsed: boolean): void {
    if (collapsed === this.collapsed) {
      return;
    }
    this.collapsed = collapsed;
    this.updateCollapseButton();
    this.updateVisibility();
    if (!collapsed) {
      // 展开时给键表一个稳定锚点（材料音域）；播放不驱动横移，此初始定位不算拉回
      this.refreshSize();
      this.scrollToTuneRange();
      this.updateArrows();
    }
  }

  private updateCollapseButton(): void {
    const label = t(this.collapsed ? 'keyboard-expand' : 'keyboard-collapse');
    this.elements.collapseButton.textContent = label;
    this.elements.collapseButton.setAttribute('aria-label', label);
    this.elements.collapseButton.setAttribute('aria-expanded', String(!this.collapsed));
  }

  /** 可见性（SPEC-PLAY-08）：有材料时显示；收起只隐藏键表 / 说明 / 音域选择，dock 条保留。 */
  private updateVisibility(): void {
    const visible = this.hasTune;
    this.elements.section.hidden = !visible;
    this.elements.scroll.hidden = this.collapsed;
    if (this.rangeLabel !== null) {
      this.rangeLabel.hidden = this.collapsed;
    }
    this.updateNote();
    if (!visible || this.collapsed) {
      this.updateArrows();
    }
  }

  /** 重建键表（SPEC-PLAY-08）：当前模式与音域下按键序生成琴键；琴键纯可视、不进 Tab 顺序。 */
  private rebuild(): void {
    this.tuneRange = computeTuneRange(this.tunePitches);
    const pitches = keyPitches(this.mode, this.tuneRange);
    this.keyElements.clear();
    const fragment = document.createDocumentFragment();
    for (const pitch of pitches) {
      const key = document.createElement('div');
      key.className = isBlackKey(pitch)
        ? 'abcdesk-key abcdesk-key-black'
        : 'abcdesk-key abcdesk-key-white';
      key.dataset.pitch = String(pitch);
      key.dataset.note = pitchName(pitch);
      // 琴键纯可视（SPEC-PLAY-09）：无按钮语义、不进入 Tab 顺序，描述由滚动容器承载（SPEC-A11Y-15）
      key.setAttribute('aria-hidden', 'true');
      fragment.appendChild(key);
      this.keyElements.set(pitch, key);
    }
    this.elements.keys.replaceChildren(fragment);
    this.updateVisibility();
    this.applyActiveClasses();
    this.refreshSize();
    this.scrollToTuneRange();
    this.updateArrows();
  }

  /** 键尺寸（SPEC-PLAY-08）：只重算 CSS 变量，不清滚动位置。 */
  private refreshSize(): void {
    const whiteCount = [...this.keyElements.keys()].filter((pitch) => !isBlackKey(pitch)).length;
    const metrics = computeKeyMetrics(this.elements.scroll.clientWidth, whiteCount);
    const style = this.elements.keys.style;
    style.setProperty('--abcdesk-white-key-width', `${metrics.whiteWidth}px`);
    style.setProperty('--abcdesk-white-key-height', `${metrics.whiteHeight}px`);
    style.setProperty('--abcdesk-black-key-width', `${metrics.blackWidth}px`);
    style.setProperty('--abcdesk-black-key-height', `${metrics.blackHeight}px`);
    style.setProperty('--abcdesk-black-key-offset', `${metrics.blackOffset}px`);
  }

  /** 初始 / 重建后的滚动锚点：把材料音域居中；播放事件不触发（不自动横移，SPEC-PLAY-08）。 */
  private scrollToTuneRange(): void {
    const startKey = this.keyElements.get(this.tuneRange.start);
    const endKey = this.keyElements.get(this.tuneRange.end);
    if (startKey === undefined || endKey === undefined) {
      return;
    }
    const scroll = this.elements.scroll;
    const scrollRect = scroll.getBoundingClientRect();
    const startRect = startKey.getBoundingClientRect();
    const endRect = endKey.getBoundingClientRect();
    const center = (startRect.left + endRect.right) / 2 - scrollRect.left + scroll.scrollLeft;
    scroll.scrollLeft = Math.max(0, center - scroll.clientWidth / 2);
  }

  /** 键着色（SPEC-PLAY-09 / 15）：播放高亮与查阅反射各自独立开关，同键命中时 CSS 让播放色优先。 */
  private applyActiveClasses(): void {
    const active = new Set(this.activePitches);
    const pointed = new Set(this.pointedPitches);
    for (const [pitch, element] of this.keyElements) {
      element.classList.toggle('abcdesk-key-active', active.has(pitch));
      element.classList.toggle('abcdesk-key-pointed', pointed.has(pitch));
    }
  }

  /**
   * 方向提示（SPEC-PLAY-08）：可视窗口外有提示音时在对应边缘显示箭头；
   * 只提示方向，不滚动、不把用户的手动浏览拉回。
   */
  private updateArrows(): void {
    const { leftArrow, rightArrow, scroll } = this.elements;
    if (!this.hasTune || this.collapsed || this.activePitches.length === 0) {
      leftArrow.hidden = true;
      rightArrow.hidden = true;
      return;
    }
    const scrollRect = scroll.getBoundingClientRect();
    let leftOut = false;
    let rightOut = false;
    for (const pitch of this.activePitches) {
      const key = this.keyElements.get(pitch);
      if (key === undefined) {
        continue;
      }
      const rect = key.getBoundingClientRect();
      if (rect.right <= scrollRect.left + 1) {
        leftOut = true;
      } else if (rect.left >= scrollRect.right - 1) {
        rightOut = true;
      }
    }
    leftArrow.hidden = !leftOut;
    rightArrow.hidden = !rightOut;
  }

  /** 说明行（SPEC-STATE-05 / PLAY-08）：无音高材料说明没有提示；超出 A0–C8 的音高不折返、明确提示。 */
  private updateNote(): void {
    const text = this.noteText();
    this.elements.note.textContent = text ?? '';
    this.elements.note.hidden = text === null || this.collapsed;
  }

  private noteText(): string | null {
    if (!this.hasTune) {
      return null;
    }
    if (this.tunePitches.length === 0) {
      return t('keyboard-no-pitch');
    }
    if (outOfRangePitches(this.tunePitches).length > 0) {
      return t('keyboard-out-of-range');
    }
    return null;
  }
}

function readMode(select: HTMLSelectElement): KeyboardRangeMode {
  return select.value === 'full' ? 'full' : 'tune';
}
