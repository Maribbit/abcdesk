import { renderAbc, type AbcElem, type NoteTimingEvent, type TuneObject } from 'abcjs';
import { parseHostMessage, type DocumentMessage, type SourceHighlightRange } from '../core/messages';
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
 * - 点击谱面音符设为目标并请求源码定位（焦点留在预览），不改变播放位置、不额外发声；
 * - 当前目标音符（点选 / 查阅共用，后发生者胜）以填充 + 包围虚线框呈现，与播放高亮形状与颜色双重区分；
 * - 播放位置超出可视区域自动跟随滚动，手动滚动后暂停并显示"恢复跟随"；
 * - "从此处播放"按可靠映射定位起播，映射不可靠或联动停用时说明原因（不悄悄从头播放）；
 * - 控制区"从此处播放"按钮对当前目标音符起播（SPEC-PLAY-12），可用性随目标与联动状态刷新。
 * 键盘（SPEC-PLAY-08 / 09 / 15、STATE-03 / 05）：
 * - 键盘默认按当前曲目材料音域（至少两个八度）、可切换完整 88 键与手动收起；
 *   播放高亮跟随演奏时间（含静音声部），视口外的提示音只显示方向箭头；
 * - 目标音符以查阅色反射到键盘（SPEC-PLAY-15），随目标一同清除。
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
/** 当前目标音符的字符偏移（SPEC-PLAY-11 / 12 / 15）：预览点选或源码光标命中共同维护，后发生者胜；谱面标记、键盘反射与"从此处播放"可用性据它同步。 */
let targetOffset: number | null = null;
/** 目标音符的谱面元素（SPEC-PLAY-11）：滚动定位依据，更新目标时先清旧再亮新。 */
let targetElements: SVGElement[] = [];
/** 目标音符的覆盖层框（SPEC-PLAY-11）：随目标更新整体重建，换版 / 停用时清除。 */
let readingBoxes: HTMLDivElement[] = [];
/** 渲染时各元素 fill 属性快照（SPEC-PLAY-11）：abcjs 原生点选直接覆写该 presentation 属性、不随类移除复原，清除标记时据此还原。 */
let nativeFillSnapshot = new WeakMap<Element, string | null>();
/** 最近一次回传给宿主的目标源码区间序列化结果（SPEC-PLAY-11）：同一音符内的连续光标移动不重复发送。 */
let sentTargetRanges: string | undefined;
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
  // 快照 abcjs 绘制的原生 fill 属性（SPEC-PLAY-11）：原生点选会覆写该属性，清除标记时按此还原
  snapshotNativePaint();
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

/** 联动状态随渲染重建（SPEC-PLAY-11）：映射、目标与跟随状态全部清空，成功后再建立新映射。 */
function resetLinkageState(): void {
  timingEvents = [];
  applyTarget(null); // 目标清除：标记、键盘反射与按钮状态随渲染重建（SPEC-PLAY-11 / 12 / 15）
  setMarkerClass(playingElements, 'abcdesk-playing', false);
  playingElements = [];
  followPaused = false;
  keyboardView.clearActivePitches(); // 换版 / 重渲染清除键盘动态提示（SPEC-STATE-03）
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

/**
 * 回传当前目标的源码区间（SPEC-PLAY-11）：宿主据此同步编辑器侧轮廓标记；
 * 联动停用（有待更新 / 旧谱参考）时跳过——宿主在内容变化时已清除轮廓，避免套用旧映射。
 */
function syncTargetSourceRanges(ranges: SourceHighlightRange[]): void {
  if (linkageUnavailableReason() !== undefined) {
    return;
  }
  const serialized = JSON.stringify(ranges);
  if (serialized === sentTargetRanges) {
    return;
  }
  sentTargetRanges = serialized;
  host.postMessage({ type: 'target-ranges', ranges });
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

/** 点击谱面音符（SPEC-PLAY-11 / 12）：设为目标并请求源码定位，焦点留在预览、不改变播放位置、不额外发声。 */
function handleScoreClick(abcElem: AbcElem): void {
  const startChar = abcElem.startChar;
  const endChar = abcElem.endChar;
  if (abcElem.el_type !== 'note' || startChar === undefined || endChar === undefined) {
    // 点到非音符元素（小节线、谱号等）：清除目标（标记、键盘反射与按钮同步），不请求定位（无有效映射）
    applyTarget(null);
    return;
  }
  // 点选加入目标（SPEC-PLAY-11 / 12）：与查阅光标共用同一目标，后发生者胜
  applyTarget(startChar);
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

/** 从当前目标音符起播（SPEC-PLAY-12 / CMD-08）：目标由点选或查阅维护，无目标时回原因说明。 */
function startFromTarget(): void {
  if (targetOffset === null) {
    const unavailable = linkageUnavailableReason();
    host.postMessage({ type: 'linkage-unavailable', reason: unavailable ?? 'no-selection' });
    return;
  }
  playFromOffset(targetOffset);
}

/**
 * 查阅光标（SPEC-PLAY-11 / 12）：命中音符时成为当前目标；离开音符 / 位于其他曲目时清除目标，
 * 不自动切曲、不套用当前曲目的映射。
 */
function applyReadingMarker(offset: number | null): void {
  applyTarget(offset !== null && findTimingEvent(offset) !== undefined ? offset : null);
}

/**
 * 设定 / 清除当前目标音符（SPEC-PLAY-11 / 12 / 15）：预览点选与源码光标命中维护同一目标，
 * 后发生者胜；填充与包围虚线框、键盘反射与"从此处播放"可用性随目标同步。
 * 偏移无可靠映射（如旧谱参考、点选后等待重渲染）时不呈现标记、保留目标，由按钮说明原因。
 */
function applyTarget(offset: number | null): void {
  clearTargetMarks();
  targetOffset = offset;
  const event = offset === null ? undefined : findTimingEvent(offset);
  // 编辑器侧轮廓随目标同步（SPEC-PLAY-11）：宿主按区间回传绘制轮廓，目标清除时回传空数组
  syncTargetSourceRanges(event === undefined ? [] : sourceRangesOf(event));
  if (event === undefined) {
    keyboardView.clearPointedPitches();
    updatePlayFromHereButton();
    return;
  }
  targetElements = elementsOf(event);
  setMarkerClass(targetElements, 'abcdesk-target', true);
  drawReadingBoxes(event);
  // 键盘反射（SPEC-PLAY-15）：与目标共用同一映射，以查阅色突出对应琴键
  keyboardView.setPointedPitches(collectPitches([event]));
  updatePlayFromHereButton();
  if (controller.getStatus().phase !== 'playing') {
    // 目标不可见时带进视野；播放中只更新标记、不抢播放跟随的滚动（SPEC-PLAY-11）
    scrollIntoViewIfNeeded(targetElements);
  }
}

/**
 * 清除旧目标标记（SPEC-PLAY-11 / 12）：填充、包围虚线框与元素引用一并清；
 * abcjs 原生选中由点选自行添加、不会随目标移动移除，而且不止类：原生点选把填充色直接写进音符的
 * presentation 属性，类移除后该属性仍生效——一并按渲染快照还原，旧音符不留任何残留。
 */
function clearTargetMarks(): void {
  clearReadingBoxes();
  for (const element of scoreElement.querySelectorAll('.abcdesk-target, .abcjs-note_selected')) {
    element.classList.remove('abcdesk-target', 'abcjs-note_selected');
    restoreNativePaint(element);
  }
  targetElements = [];
}

/** 记录谱面元素的原始 fill 属性（SPEC-PLAY-11）：渲染成功后、任何点选发生前调用。 */
function snapshotNativePaint(): void {
  nativeFillSnapshot = new WeakMap();
  for (const element of scoreElement.querySelectorAll('*')) {
    nativeFillSnapshot.set(element, element.getAttribute('fill'));
  }
}

/** 还原 abcjs 原生点选覆写的 fill 属性（SPEC-PLAY-11）：快照缺记（渲染后新增元素）时视为原本无该属性。 */
function restoreNativePaint(element: Element): void {
  const fill = nativeFillSnapshot.get(element);
  if (fill === null || fill === undefined) {
    element.removeAttribute('fill');
  } else {
    element.setAttribute('fill', fill);
  }
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
 * 面板尺寸变化后重绘目标虚线框（SPEC-PLAY-11）：abcjs 响应式模式按容器宽度纯 CSS 缩放
 * SVG 而不重排版，覆盖层的像素几何需按当前元素重新测量，否则会漂离音符。
 */
function refreshReadingBoxes(): void {
  if (targetOffset === null) {
    return;
  }
  const event = findTimingEvent(targetOffset);
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
 * "从此处播放"按钮（SPEC-PLAY-12）：对当前目标音符起播，与命令共用宿主路径；
 * 无目标音符、有待更新或旧谱参考时禁用，原因经包裹元素提示（禁用按钮自身不触发悬停提示）；
 * 原因按实际停用状态取：联动停用优先于无目标提示。
 */
function updatePlayFromHereButton(): void {
  const label = t('play-from-here');
  playFromHereButton.textContent = label;
  playFromHereButton.setAttribute('aria-label', label);
  const reasonKey =
    linkageUnavailableReason() ?? (targetOffset === null ? 'select-note-first' : undefined);
  const reason = reasonKey === undefined ? undefined : t(reasonKey);
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
    startFromTarget();
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
