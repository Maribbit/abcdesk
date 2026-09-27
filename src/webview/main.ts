import { renderAbc, type AbcElem, type NoteTimingEvent, type TuneObject } from 'abcjs';
import { parseHostMessage, type DocumentMessage } from '../core/messages';
import { PlaybackController } from './audio';
import { KeyboardView, collectPitches } from './keyboard';
import { t } from './l10n';

/**
 * 播放器 webview 入口（M0：渲染管线、播放主干、编辑更新管线与源码联动）。
 *
 * 全部宿主通信必须经消息桥，不得 import vscode（见 docs/conventions.md）；
 * 消息形状不完整时忽略，不信任宿主以外的来源（SPEC-ENV-04）。
 * 内容更新策略（SPEC-STATE-03 / 05 / 07 / 08）：
 * - 播放中到达的新版本只缓存并提示"文件已更新，暂停后应用"，不提前换版；
 * - 暂停 / 停止 / 自然结束 / 隐藏或接替触发暂停时统一应用缓存版本（归零、不自动起播）；
 * - 渲染失败保留旧谱并标记仅供参考、禁用旧谱播放；无旧谱时显示错误占位；
 * - 空白内容显示空状态与"转到源码编辑"入口，不把旧谱当成当前内容。
 * 源码联动（SPEC-PLAY-11 / 12）：
 * - 点击谱面音符选中并请求源码定位（焦点留在预览），不改变播放位置、不额外发声；
 * - 查阅 / 点选标记（音符包围虚线框）与播放高亮（填充换色）形状与颜色双重区分；
 * - 播放位置超出可视区域自动跟随滚动，手动滚动后暂停并显示"恢复跟随"；
 * - "从此处播放"按可靠映射定位起播，映射不可靠或联动停用时说明原因（不悄悄从头播放）；
 * - 控制区"从此处播放"按钮对所选音符起播（SPEC-PLAY-12），可用性随选择与联动状态刷新。
 * 键盘（SPEC-PLAY-08 / 09 / 15、STATE-03 / 05）：
 * - 键盘默认按当前曲目材料音域（至少两个八度）、可切换完整 88 键与手动收起；
 *   播放高亮跟随演奏时间（含静音声部），视口外的提示音只显示方向箭头；
 * - 光标 / 点选命中的音符以查阅色反射到键盘（SPEC-PLAY-15），随查阅标记一同清除。
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const host = acquireVsCodeApi();

function queryElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`ABC Desk webview: missing element #${id}`);
  }
  return element as T;
}

const topbarElement = queryElement('topbar');
const scoreElement = queryElement('score');
const playButton = queryElement<HTMLButtonElement>('play');
const stopButton = queryElement<HTMLButtonElement>('stop');
const playbackStatusElement = queryElement('playback-status');
const contentStatusElement = queryElement('content-status');
const contentStatusTextElement = queryElement('content-status-text');
const revealSourceButton = queryElement<HTMLButtonElement>('reveal-source');
const followResumeButton = queryElement<HTMLButtonElement>('follow-resume');
const playFromHereWrap = queryElement('play-from-here-wrap');
const playFromHereButton = queryElement<HTMLButtonElement>('play-from-here');

/** 播放中到达、待统一应用的最新文档（SPEC-STATE-07）。 */
let pendingDocument: DocumentMessage | undefined;
/** 内容状态区的文案键：暂停后应用 / 旧谱参考 / 空状态。 */
let contentStatusKey: string | null = null;
/** 空状态是否显示"转到源码编辑"入口（SPEC-STATE-05）。 */
let showRevealSource = false;
/** 谱面区是否已有成功渲染的谱面：渲染失败时据此决定保留参考还是错误占位（SPEC-STATE-03）。 */
let hasRenderedScore = false;
/** 当前版本的演奏时序（SPEC-PLAY-11 / 12）：字符↔音符↔元素映射的唯一依据，随渲染重建。 */
let timingEvents: NoteTimingEvent[] = [];
/** 预览内点击选中的音符（SPEC-PLAY-12 的"从所选音符播放"依据）；重渲染时清除。 */
let selectedNote: { startChar: number; endChar: number } | undefined;
/** 查阅标记的当前目标元素（SPEC-PLAY-11）：滚动定位依据，更新标记时先清旧再亮新。 */
let readingElements: SVGElement[] = [];
/** 查阅标记的覆盖层框（SPEC-PLAY-11）：随标记更新整体重建，换版 / 停用时清除。 */
let readingBoxes: HTMLDivElement[] = [];
/** 查阅标记对应的源码字符偏移（SPEC-PLAY-11）：面板尺寸变化后据此按新几何重绘。 */
let readingOffset: number | null = null;
/** 播放高亮的当前目标元素（SPEC-PLAY-11）。 */
let playingElements: SVGElement[] = [];
/** 播放中用户手动滚动谱面后暂停自动跟随（SPEC-PLAY-11）；停止或换版时重置。 */
let followPaused = false;

// 宿主注入的配置（previewPanel 以 nonce 脚本写入）：本地音色根地址（SPEC-ENV-05 / 07）
const webviewConfig = (window as unknown as { __abcdesk?: { soundfontUrl?: unknown } }).__abcdesk;
const soundfontUrl = typeof webviewConfig?.soundfontUrl === 'string' ? webviewConfig.soundfontUrl : undefined;

const controller = new PlaybackController({ soundfontUrl }, refreshPlaybackUi, applyPlayingHighlight);

/** 键盘可视化（SPEC-PLAY-08 / 09）：音域 / 收起两态独立，动态高亮由播放事件驱动。 */
const keyboardSection = queryElement('keyboard');
const keyboardView = new KeyboardView({
  section: keyboardSection,
  caption: queryElement('keyboard-caption'),
  note: queryElement('keyboard-note'),
  scroll: queryElement('keyboard-scroll'),
  keys: queryElement('keyboard-keys'),
  rangeSelect: queryElement<HTMLSelectElement>('keyboard-range'),
  collapseButton: queryElement<HTMLButtonElement>('keyboard-collapse'),
  leftArrow: queryElement('keyboard-hint-left'),
  rightArrow: queryElement('keyboard-hint-right'),
});

/** 按当前相位刷新按钮标签、状态文案并上报播放状态（SPEC-PLAY-01 / 13）。 */
function refreshPlaybackUi(): void {
  if (pendingDocument !== undefined) {
    const { phase } = controller.getStatus();
    if (phase === 'idle' || phase === 'paused') {
      // 暂停 / 停止 / 自然结束 / 隐藏或接替触发暂停：统一应用更新并归零（SPEC-STATE-07）
      applyPendingDocument();
    }
  }
  const { phase, statusKey } = controller.getStatus();
  if (phase === 'idle') {
    // 停止 / 自然结束 / 取消起播：跟随状态重置（SPEC-PLAY-11）
    followPaused = false;
  }
  const labelKey = phase === 'preparing' ? 'cancel-prepare' : phase === 'playing' ? 'pause' : 'play';
  const label = t(labelKey);
  playButton.textContent = label;
  playButton.setAttribute('aria-label', label); // 可访问名称与按钮文案同步（SPEC-PLAY-01）
  stopButton.textContent = t('stop');
  stopButton.setAttribute('aria-label', t('stop'));
  playbackStatusElement.textContent = statusKey === null ? '' : t(statusKey);
  updateFollowResumeButton();
  // 宿主据此维持同一窗口内只有一处预览发声（SPEC-PLAY-01）
  host.postMessage({ type: 'playback-state', state: phase });
}

/** 应用缓存的最新版本：渲染与换版归零（SPEC-STATE-07），不自动起播；上报结果供宿主解除联动停用（SPEC-PLAY-11）。 */
function applyPendingDocument(): void {
  const message = pendingDocument;
  if (message === undefined) {
    return;
  }
  pendingDocument = undefined;
  renderAndReport(message);
}

/** 渲染并上报结果：两条渲染路径（直接应用与暂停后换版）共用（SPEC-CMD-07 的待起播请求据 rendered 执行）。 */
function renderAndReport(message: DocumentMessage): void {
  const ok = renderDocument(message);
  host.postMessage({ type: 'rendered', version: message.version, ok });
}

/** 内容状态区（SPEC-STATE-08）：旧谱参考 / 空状态 / 暂停后应用提示与"转到源码编辑"入口。 */
function updateContentStatus(): void {
  contentStatusElement.hidden = contentStatusKey === null && !showRevealSource;
  contentStatusTextElement.textContent = contentStatusKey === null ? '' : t(contentStatusKey);
  revealSourceButton.hidden = !showRevealSource;
  if (showRevealSource) {
    revealSourceButton.textContent = t('reveal-source');
    revealSourceButton.setAttribute('aria-label', t('reveal-source'));
  }
  // 内容状态变化同时影响"从此处播放"可用性（待更新 / 旧谱参考，SPEC-PLAY-12）
  updatePlayFromHereButton();
}

/** 空状态：清空谱面、提示"文件尚无音乐内容"并提供"转到源码编辑"入口（SPEC-STATE-05）。 */
function showEmptyState(): void {
  scoreElement.textContent = '';
  hasRenderedScore = false;
  contentStatusKey = 'empty-file';
  showRevealSource = true;
  controller.setTune(undefined);
  keyboardView.clear(); // 空状态不显示键盘（SPEC-STATE-05，键盘区随材料出现 / 消失）
  updateContentStatus();
}

/** 渲染宿主推送的文档；返回渲染是否成功（SPEC-CMD-07 的待起播请求据此执行）。 */
function renderDocument(message: DocumentMessage): boolean {
  // 来源文件名与“尚未保存”标记由预览标签标题显示（SPEC-CMD-06），webview 内不重复呈现

  // 联动状态随渲染重建（SPEC-PLAY-11）：映射、选中与旧标记引用全部清空，成功后再建立新映射
  resetLinkageState();

  if (message.abc.trim() === '') {
    // 完全空白：直接进入空状态，不交给渲染器（SPEC-STATE-05）
    showEmptyState();
    return true;
  }

  // 先留旧谱节点引用：渲染可能中途失败，失败时恢复，保证保留上一次成功渲染的谱面（SPEC-STATE-03）
  const previousNodes = Array.from(scoreElement.childNodes);
  let tune: TuneObject | undefined;
  try {
    tune = renderAbc(scoreElement, message.abc, {
      responsive: 'resize',
      add_classes: true,
      clickListener: (abcElem) => handleScoreClick(abcElem),
    })[0];
  } catch (error) {
    console.error('ABC Desk: render failed', error);
    if (hasRenderedScore) {
      // 保留旧谱并标记"仅供参考"（SPEC-STATE-03）；旧谱与源码的联动保持停用
      scoreElement.replaceChildren(...previousNodes);
      contentStatusKey = 'stale-score';
      keyboardView.clearActivePitches(); // 旧谱参考清除键盘动态提示，键盘随旧版本保留（SPEC-STATE-03）
    } else {
      // 首次失败且无旧谱：错误占位（SPEC-STATE-03）
      scoreElement.textContent = '';
      const fallback = document.createElement('p');
      fallback.textContent = t('render-failed');
      scoreElement.appendChild(fallback);
      contentStatusKey = null;
      keyboardView.clear();
    }
    showRevealSource = false;
    controller.setTune(undefined); // 禁用旧谱播放，避免播放已失效版本（SPEC-STATE-03）
    updateContentStatus();
    return false;
  }

  if (tune === undefined || !tuneHasNotes(tune)) {
    // 空白内容：空状态与转到源码编辑入口，不把旧谱当成当前内容（SPEC-STATE-05）
    showEmptyState();
    return true;
  }

  hasRenderedScore = true;
  contentStatusKey = null;
  showRevealSource = false;
  controller.setTune(tune);
  // 建立字符↔演奏时序映射（SPEC-PLAY-11 / 12）：与播放共用同一份时序（P02：反复取第一次出现）
  timingEvents = controller.getTimings();
  // 键盘按当前版本的材料音高重建音域（SPEC-PLAY-08）：单曲目材料、含静音声部，不合并其他曲目
  keyboardView.setTune(collectPitches(timingEvents));
  updateContentStatus();
  return true;
}

/** 谱面是否含可显示的音符（空状态判据，SPEC-STATE-05）：休止符（rest）也是 note 条目，全休止符不算空文件。 */
function tuneHasNotes(tune: TuneObject): boolean {
  for (const line of tune.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const item of voice) {
          if (item.el_type === 'note') {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** 联动状态随渲染重建（SPEC-PLAY-11）：映射、选中、标记引用与跟随状态全部清空。 */
function resetLinkageState(): void {
  timingEvents = [];
  selectedNote = undefined;
  readingOffset = null;
  clearReadingBoxes();
  setMarkerClass(playingElements, 'abcdesk-playing', false);
  readingElements = [];
  playingElements = [];
  followPaused = false;
  keyboardView.clearActivePitches(); // 换版 / 重渲染清除键盘动态提示（SPEC-STATE-03）
  keyboardView.clearPointedPitches(); // 换版 / 重渲染清除查阅 / 点选反射（SPEC-PLAY-15）
  updatePlayFromHereButton();
}

/** 给元素批量加 / 去标记类（SPEC-PLAY-11）；CSS 负责呈现，移除类即恢复原样式。 */
function setMarkerClass(elements: SVGElement[], className: string, on: boolean): void {
  for (const element of elements) {
    element.classList.toggle(className, on);
  }
}

/** 提取时序事件对应的谱面 DOM 元素（elements 为原 elemset 展平）。 */
function elementsOf(event: NoteTimingEvent): SVGElement[] {
  return eventGroups(event).flat();
}

/**
 * 字符偏移 → 演奏时序事件（SPEC-PLAY-11 / 12）：字符范围按左闭右开（abcjs 约定）；
 * 反复中多次出现的音符按演奏时序取第一次出现（P02 决议，见 docs/decisions.md）。
 */
function findTimingEvent(offset: number): NoteTimingEvent | undefined {
  let found: NoteTimingEvent | undefined;
  for (const event of timingEvents) {
    if (event.type !== 'event' || !eventRangeContains(event, offset)) {
      continue;
    }
    if (found === undefined || event.milliseconds < found.milliseconds) {
      found = event;
    }
  }
  return found;
}

/** 事件是否覆盖该字符偏移；tie 场景下字符范围与元素可能错位，按较短长度比对。 */
function eventRangeContains(event: NoteTimingEvent, offset: number): boolean {
  const starts = event.startCharArray ?? [];
  const ends = event.endCharArray ?? [];
  const count = Math.min(starts.length, ends.length);
  for (let index = 0; index < count; index += 1) {
    if (offset >= starts[index] && offset < ends[index]) {
      return true;
    }
  }
  return false;
}

/** 播放高亮对应的源码字符区间（SPEC-PLAY-11 的源码装饰依据）。 */
function sourceRangesOf(event: NoteTimingEvent): Array<{ start: number; end: number }> {
  const starts = event.startCharArray ?? [];
  const ends = event.endCharArray ?? [];
  const count = Math.min(starts.length, ends.length);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < count; index += 1) {
    ranges.push({ start: starts[index], end: ends[index] });
  }
  return ranges;
}

/** 联动是否处于停用窗口（SPEC-PLAY-11）：有待应用的新版本或当前为旧谱参考时不可定位 / 起播。 */
function linkageUnavailableReason(): 'update-pending' | 'stale-score' | undefined {
  if (pendingDocument !== undefined) {
    return 'update-pending';
  }
  if (contentStatusKey === 'stale-score') {
    return 'stale-score';
  }
  return undefined;
}

/** 点击谱面音符（SPEC-PLAY-11）：选中并请求源码定位，焦点留在预览、不改变播放位置、不额外发声。 */
function handleScoreClick(abcElem: AbcElem): void {
  const startChar = abcElem.startChar;
  const endChar = abcElem.endChar;
  if (abcElem.el_type !== 'note' || startChar === undefined || endChar === undefined) {
    // 点到非音符元素（小节线、谱号等）：清除所选音符与键盘反射，不请求定位（无有效映射）
    selectedNote = undefined;
    keyboardView.clearPointedPitches();
    updatePlayFromHereButton();
    return;
  }
  selectedNote = { startChar, endChar };
  updatePlayFromHereButton();
  reflectPointedPitches(startChar); // 点选反射（SPEC-PLAY-15）：与查阅标记共用同一映射
  const unavailable = linkageUnavailableReason();
  if (unavailable !== undefined) {
    host.postMessage({ type: 'linkage-unavailable', reason: unavailable });
    return;
  }
  host.postMessage({ type: 'reveal-range', start: startChar, end: endChar });
}

/** "从此处播放"公共路径（SPEC-PLAY-12）：映射不可靠或联动停用时说明原因，不悄悄从头播放。 */
function playFromOffset(offset: number): void {
  const unavailable = linkageUnavailableReason();
  if (unavailable !== undefined) {
    host.postMessage({ type: 'linkage-unavailable', reason: unavailable });
    return;
  }
  const event = findTimingEvent(offset);
  if (event === undefined) {
    host.postMessage({ type: 'linkage-unavailable', reason: 'no-mapping' });
    return;
  }
  controller.playFromMs(event.milliseconds);
}

/** 从源码光标起播（SPEC-PLAY-12）：偏移来自宿主推送，映射在 webview 内完成。 */
function startFromCursor(offset: number): void {
  playFromOffset(offset);
}

/** 从预览所选音符起播（SPEC-PLAY-12）：只取预览内的选择，不借用一旁源码的光标。 */
function startFromSelection(): void {
  if (selectedNote === undefined) {
    const unavailable = linkageUnavailableReason();
    host.postMessage({ type: 'linkage-unavailable', reason: unavailable ?? 'no-selection' });
    return;
  }
  playFromOffset(selectedNote.startChar);
}

/**
 * 查阅标记（SPEC-PLAY-11）：以音符包围虚线框突出光标对应音符，必要时滚动使其可见；
 * 播放中只更新标记、不抢播放跟随的滚动，也不改变音乐。
 */
function applyReadingMarker(offset: number | null): void {
  clearReadingBoxes();
  readingElements = [];
  readingOffset = offset;
  if (offset === null) {
    keyboardView.clearPointedPitches();
    return;
  }
  const event = findTimingEvent(offset);
  if (event === undefined) {
    keyboardView.clearPointedPitches();
    return;
  }
  // 键盘反射（SPEC-PLAY-15）：与查阅标记同一映射，以查阅色突出对应琴键
  keyboardView.setPointedPitches(collectPitches([event]));
  readingElements = elementsOf(event);
  drawReadingBoxes(event);
  if (controller.getStatus().phase !== 'playing') {
    scrollIntoViewIfNeeded(readingElements);
  }
}

/** 点选反射（SPEC-PLAY-15）：偏移命中音符时突出对应琴键，无映射时清除。 */
function reflectPointedPitches(offset: number): void {
  const event = findTimingEvent(offset);
  keyboardView.setPointedPitches(event === undefined ? [] : collectPitches([event]));
}

/** 移除全部查阅框（SPEC-PLAY-11）。 */
function clearReadingBoxes(): void {
  for (const box of readingBoxes) {
    box.remove();
  }
  readingBoxes = [];
}

/** 查阅框与音符之间的留白（布局像素）。 */
const READING_BOX_PADDING = 3;

/**
 * 绘制查阅框（SPEC-PLAY-11）：按音符簇的屏幕包围盒生成覆盖层虚线框；
 * 覆盖层不进入 abcjs 的 SVG 节点、CSS 关闭命中，点击判定不受影响。
 */
function drawReadingBoxes(event: NoteTimingEvent): void {
  const container = scoreElement.getBoundingClientRect();
  for (const group of eventGroups(event)) {
    const rect = unionRect(group);
    if (rect === undefined) {
      continue;
    }
    const box = document.createElement('div');
    box.className = 'abcdesk-reading-box';
    box.style.left = `${rect.left - container.left - READING_BOX_PADDING}px`;
    box.style.top = `${rect.top - container.top - READING_BOX_PADDING}px`;
    box.style.width = `${rect.right - rect.left + READING_BOX_PADDING * 2}px`;
    box.style.height = `${rect.bottom - rect.top + READING_BOX_PADDING * 2}px`;
    scoreElement.appendChild(box);
    readingBoxes.push(box);
  }
}

/**
 * 面板尺寸变化后重绘查阅框（SPEC-PLAY-11）：abcjs 响应式模式按容器宽度纯 CSS 缩放
 * SVG 而不重排版，覆盖层的像素几何需按当前元素重新测量，否则会漂离音符。
 */
function refreshReadingBoxes(): void {
  if (readingOffset === null) {
    return;
  }
  const event = findTimingEvent(readingOffset);
  if (event === undefined) {
    return;
  }
  clearReadingBoxes();
  drawReadingBoxes(event);
}

/** 时序事件的元素按音符簇分组（SPEC-PLAY-11）：和弦为一组，tie 展开的各簇各自成组。 */
function eventGroups(event: NoteTimingEvent): SVGElement[][] {
  const groups: SVGElement[][] = [];
  for (const group of event.elements ?? []) {
    const members: SVGElement[] = [];
    for (const element of group) {
      if (element instanceof SVGElement) {
        members.push(element);
      }
    }
    if (members.length > 0) {
      groups.push(members);
    }
  }
  return groups;
}

/**
 * 播放高亮（SPEC-PLAY-11）：谱面换色、源码高亮回传与视口外跟随滚动；
 * 事件为 null（结束 / 停止 / 换版）时清除两处高亮。
 */
function applyPlayingHighlight(event: NoteTimingEvent | null): void {
  setMarkerClass(playingElements, 'abcdesk-playing', false);
  playingElements = [];
  if (event === null || event.type !== 'event') {
    keyboardView.setActivePitches([]);
    host.postMessage({ type: 'source-highlight', ranges: [] });
    return;
  }
  playingElements = elementsOf(event);
  setMarkerClass(playingElements, 'abcdesk-playing', true);
  // 键盘提示跟随记谱材料的演奏时间、含静音声部（SPEC-PLAY-09）；视口外只显示方向箭头（SPEC-PLAY-08）
  keyboardView.setActivePitches(collectPitches([event]));
  // 源码只高亮、不滚动、不移动光标；由宿主对可见编辑器设置装饰（SPEC-PLAY-11）
  host.postMessage({ type: 'source-highlight', ranges: sourceRangesOf(event) });
  if (!followPaused) {
    scrollIntoViewIfNeeded(playingElements);
  }
}

/**
 * 谱面元素超出可视区域时滚动使其可见（SPEC-PLAY-11）；程序化滚动不触发"手动滚动"判定。
 * 视口底边扣除键盘 dock 高度：贴底的键盘不算可视区域，跟随不把音符滚到键盘底下。
 */
function scrollIntoViewIfNeeded(elements: SVGElement[]): void {
  const rect = unionRect(elements);
  if (rect === undefined) {
    return;
  }
  const margin = 32;
  // 顶部预留顶栏实际高度（换行变高时随之更新）：滚动后音符不被粘住的控制区遮住
  const viewTop = topbarElement.offsetHeight;
  const viewBottom = window.innerHeight - keyboardSection.offsetHeight;
  if (rect.bottom > viewBottom - margin) {
    window.scrollBy({ top: rect.bottom - viewBottom + margin });
  } else if (rect.top < viewTop + margin) {
    window.scrollBy({ top: rect.top - viewTop - margin });
  }
}

/** 元素集合的屏幕包围盒；全部为空图形（如不可见休止符）时返回 undefined。 */
function unionRect(
  elements: SVGElement[],
): { left: number; top: number; right: number; bottom: number } | undefined {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (left > right || top > bottom) {
    return undefined;
  }
  return { left, top, right, bottom };
}

/** 跟随滚动导航键（SPEC-PLAY-11）：这些按键造成的滚动视为手动滚动。 */
const FOLLOW_SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);

/** 播放中用户手动滚动谱面：暂停自动跟随，提供显式恢复入口（SPEC-PLAY-11）。 */
function pauseFollowOnUserScroll(): void {
  if (controller.getStatus().phase !== 'playing' || followPaused) {
    return;
  }
  followPaused = true;
  updateFollowResumeButton();
}

/** "恢复跟随"入口（SPEC-PLAY-11）：播放中且已手动滚动过时显示；固定定位，控制区滚出视口也可用。 */
function updateFollowResumeButton(): void {
  const visible = followPaused && controller.getStatus().phase === 'playing';
  followResumeButton.hidden = !visible;
  if (!visible) {
    return;
  }
  followResumeButton.textContent = t('resume-follow');
  followResumeButton.setAttribute('aria-label', t('resume-follow'));
}

/**
 * "从此处播放"按钮（SPEC-PLAY-12）：对预览所选音符起播，与命令共用宿主路径；
 * 未点选音符、有待更新或旧谱参考时禁用，原因经包裹元素提示（禁用按钮自身不触发悬停提示）。
 */
function updatePlayFromHereButton(): void {
  const label = t('play-from-here');
  playFromHereButton.textContent = label;
  playFromHereButton.setAttribute('aria-label', label);
  const unavailable = linkageUnavailableReason();
  let reason: string | undefined;
  if (selectedNote === undefined) {
    reason = t('select-note-first');
  } else if (unavailable !== undefined) {
    reason = t(unavailable);
  }
  playFromHereButton.disabled = reason !== undefined;
  if (reason === undefined) {
    playFromHereWrap.removeAttribute('title');
  } else {
    playFromHereWrap.setAttribute('title', reason);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = parseHostMessage(event.data);
  if (message === undefined) {
    return;
  }
  if (message.type === 'document') {
    // 播放中到达的新版本：缓存并提示，暂停 / 停止 / 自然结束时统一应用（SPEC-STATE-07）；
    // 期间旧谱与源码的联动按不可用说明（SPEC-PLAY-11），高亮由宿主清除
    if (controller.getStatus().phase === 'playing') {
      pendingDocument = message;
      contentStatusKey = 'update-pending';
      showRevealSource = false;
      updateContentStatus();
      return; // 不渲染也不上报：换版在应用时机执行
    }
    renderAndReport(message);
    return;
  }
  if (message.type === 'cursor') {
    applyReadingMarker(message.offset);
    return;
  }
  if (message.type === 'play-from-cursor') {
    startFromCursor(message.offset);
    return;
  }
  if (message.type === 'play-from-selection') {
    startFromSelection();
    return;
  }
  switch (message.action) {
    case 'toggle':
      controller.toggle();
      break;
    case 'pause':
      controller.pause();
      break;
    case 'stop':
      controller.stop();
      break;
  }
});

playButton.addEventListener('click', () => controller.toggle());
stopButton.addEventListener('click', () => controller.stop());
// "从此处播放"（SPEC-PLAY-12）：请求宿主按命令路径起播（先刷新待更新文档、失败说明复用命令路径）
playFromHereButton.addEventListener('click', () =>
  host.postMessage({ type: 'play-from-selection-request' }),
);
// 空状态"转到源码编辑"入口（SPEC-STATE-05）：请求宿主打开来源文档并转移焦点
revealSourceButton.addEventListener('click', () => host.postMessage({ type: 'reveal-source' }));
// "恢复跟随"（SPEC-PLAY-11）：立即回到当前播放位置并恢复自动跟随
followResumeButton.addEventListener('click', () => {
  followPaused = false;
  updateFollowResumeButton();
  scrollIntoViewIfNeeded(playingElements);
});

// 面板尺寸变化时谱面随容器宽度缩放（abcjs 响应式模式不重排版）：重绘覆盖层查阅框保持贴合（SPEC-PLAY-11）
new ResizeObserver(() => refreshReadingBoxes()).observe(scoreElement);

// 键盘 dock 高度驱动浮动入口的底边偏移：避免"恢复跟随"盖在键盘上
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--abcdesk-dock-height', `${keyboardSection.offsetHeight}px`);
}).observe(keyboardSection);

// 手动滚动检测（SPEC-PLAY-11）：滚动事件本身也由程序化滚动触发，因此只监听用户输入
window.addEventListener('wheel', pauseFollowOnUserScroll, { passive: true });
window.addEventListener('touchmove', pauseFollowOnUserScroll, { passive: true });
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (!FOLLOW_SCROLL_KEYS.has(event.key)) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target !== null && (target.closest('input, textarea, select') !== null || target.isContentEditable)) {
    return;
  }
  pauseFollowOnUserScroll();
});

// 预览局部空格与按钮、命令共用操作规则（SPEC-CMD-11）；按钮等交互元素上的空格保留原生行为
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== ' ' || event.defaultPrevented) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target !== null && (target.closest('button, input, textarea, select, a') !== null || target.isContentEditable)) {
    return;
  }
  event.preventDefault();
  controller.toggle();
});

// 面板销毁前立即停音（保留上下文时隐藏不会触发此处）
window.addEventListener('pagehide', () => controller.dispose());

refreshPlaybackUi();
updateContentStatus();
// 就绪握手：宿主收到 ready 后推送当前文档内容
host.postMessage({ type: 'ready' });
