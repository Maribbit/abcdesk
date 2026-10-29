// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synth } from 'abcjs';
import type { PlaybackController } from '../src/webview/audio';
import { parseWebviewMessage, type DocumentMessage, type WebviewMessage } from '../src/core/messages';
import type { PracticeUiPreferences } from '../src/core/practice';

const state = vi.hoisted(() => ({ controller: undefined as PlaybackController | undefined }));
vi.mock('../src/webview/audio', async (original) => {
  const real = await original<typeof import('../src/webview/audio')>();
  return { ...real, PlaybackController: class extends real.PlaybackController {
    constructor(...args: ConstructorParameters<typeof real.PlaybackController>) { super(...args); state.controller = this; }
  } };
});
const first = 'X:1\nT:First\nK:C\nCDEF|';
const second = 'X:2\nT:Second\nK:G\nGABc|';
const book = `${first}\n\n${second}`;
const snapshot = (abc = book, version = 1): DocumentMessage => ({ type: 'document', viewId: 1, revision: version, version, uri: 'file:///book.abc', fileName: 'book.abc', isUntitled: false, abc });
let sent: WebviewMessage[];
let listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]>;
let synths: StubSynth[];
class StubSynth {
  running = false;
  finish!: (value: { status: string }) => void;
  init = vi.fn(async () => ({}));
  prime = vi.fn(() => new Promise<{ status: string }>((resolve) => { this.finish = resolve; }));
  start = vi.fn(() => { this.running = true; });
  stop = vi.fn(() => { this.running = false; });
  pause = vi.fn(() => { this.running = false; });
  seek = vi.fn();
  getIsRunning = () => this.running;
  constructor() { synths.push(this); }
}
const send = (message: unknown) => window.dispatchEvent(new MessageEvent('message', { data: message }));
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const last = <T extends WebviewMessage['type']>(type: T) => sent.filter((message): message is Extract<WebviewMessage, { type: T }> => message.type === type).at(-1)!;
const context = () => last('context-invalidated').context;
const click = (id: string) => element<HTMLButtonElement>(id).click();
function choose(index: number, document = snapshot()) {
  element<HTMLButtonElement>('tunes').querySelector('button')!.click();
  click(`tune-option-${index}`);
  const request = last('select-tune');
  if (request !== undefined) send({ type: 'selection-snapshot', viewId: 1, requestId: request.requestId, document });
}
async function flush() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }
async function playing() {
  click('play');
  await flush();
  synths.at(-1)!.finish({ status: 'ok' });
  await flush();
  expect(state.controller!.getStatus().phase).toBe('playing');
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  sent = [];
  listeners = [];
  synths = [];
  const source = readFileSync('src/extension/previewPanel.ts', 'utf8');
  document.body.innerHTML = /<body>([\s\S]*?)<\/body>/.exec(source)![1];
  document.documentElement.lang = 'en';
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: (value: unknown) => {
    const parsed = parseWebviewMessage(value);
    expect(parsed, 'webview 必须发送完整的新协议消息').toBeDefined();
    sent.push(parsed!);
  } }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('AudioContext', class { state = 'running'; });
  Object.assign(window, { __abcdesk: { soundfontUrl: 'https://local.test/fonts/' } });
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 20, height: 10 }) });
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 20 });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(synth, 'supportsAudio').mockReturnValue(true);
  vi.spyOn(synth, 'CreateSynth').mockImplementation(StubSynth as unknown as typeof synth.CreateSynth);
  for (const target of [window, document]) {
    const original = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener !== null) listeners.push([target, type, listener, options]);
      original(type, listener, options);
    });
  }
  await import('../src/webview/main');
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const [target, type, listener, options] of listeners) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('选曲协调与真实 webview 入口', () => {
  it('[SPEC-DOC-01] [SPEC-DOC-03] 默认第一首，浏览取消与重复当前选择不停音且不准备音色', () => {
    send(snapshot());
    expect(element('tunes').textContent).toContain('Tune 1 / 2');
    expect(synths).toHaveLength(0);
    const before = context();
    element('tunes').querySelector('button')!.click();
    element('tune-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(element('tune-list').getAttribute('aria-activedescendant')).toBe('tune-option-1');
    expect(sent.filter((message) => message.type === 'select-tune')).toHaveLength(0);
    element('tune-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(element('tunes').querySelector('button'));
    choose(0);
    expect(context()).toEqual(before);
  });

  it('[SPEC-DOC-03] 逐曲设置恢复且位置归零，普通光标不跨曲', () => {
    send(snapshot());
    state.controller!.setSpeed(70);
    state.controller!.setLoopEnabled(true);
    state.controller!.seekToFraction(0.5);
    choose(1);
    expect(element('tunes').querySelector('button')!.textContent).toContain('Second');
    expect(state.controller!.getSpeed()).toBe(100);
    expect(state.controller!.getProgress().positionMs).toBe(0);
    send({ type: 'cursor', context: context(), offset: book.indexOf('CDEF') });
    expect(last('target-ranges').ranges).toEqual([]);
    choose(0);
    expect(state.controller!.getSpeed()).toBe(70);
    expect(state.controller!.getLoopEnabled()).toBe(true);
    expect(state.controller!.getProgress().positionMs).toBe(0);
    expect(synths).toHaveLength(0);
  });

  it('[SPEC-DOC-04] 播放中目录冻结，手选往返应用防抖中的最新版本且只提交一次', async () => {
    send(snapshot());
    await playing();
    const old = synths[0];
    const updated = snapshot(`${second}\n\n${first}`, 2);
    send(updated);
    expect(element('tunes').querySelector('button')!.textContent).toContain('First');
    expect(state.controller!.getStatus().phase).toBe('playing');
    const reports = sent.filter((message) => message.type === 'rendered').length;
    choose(1, updated);
    expect(old.stop).toHaveBeenCalled();
    expect(element('tunes').querySelector('button')!.textContent).toBe('Tune 1 / 2 · Second');
    expect(last('rendered').context.version).toBe(2);
    expect(sent.filter((message) => message.type === 'rendered')).toHaveLength(reports + 1);
    expect(state.controller!.getStatus().phase).toBe('idle');
    expect(synths).toHaveLength(1);
  });

  it('[SPEC-DOC-05] 防抖最新版本中的改标识不能复用旧下标；无 X: 单曲更新必须确认', () => {
    send(snapshot());
    choose(1, snapshot(`${first}\n\n${second.replace('X:2', 'X:9')}`, 2));
    expect(element<HTMLButtonElement>('play').disabled).toBe(true);
    expect(element('content-status').textContent).toContain('Please select a tune again');
    send(snapshot('K:C\nCDEF|', 3));
    expect(element('confirm-tune').hidden).toBe(false);
    click('confirm-tune');
    send({ type: 'selection-snapshot', viewId: 1, requestId: last('select-tune').requestId, document: snapshot('K:C\nCDEF|', 3) });
    expect(element<HTMLButtonElement>('play').disabled).toBe(false);
    send(snapshot('K:C\nGABc|', 4));
    expect(element('confirm-tune').hidden).toBe(false);
    expect(element<HTMLButtonElement>('play').disabled).toBe(true);
  });

  it('[SPEC-DOC-04] 停止和隐藏取消选择等待；旧响应和旧光标无效', () => {
    send(snapshot());
    const oldContext = context();
    element('tunes').querySelector('button')!.click();
    click('tune-option-1');
    const request = last('select-tune');
    send({ type: 'playback', viewId: 1, requestId: 10, action: 'pause' });
    send({ type: 'selection-snapshot', viewId: 1, requestId: request.requestId, document: snapshot() });
    expect(element('tunes').querySelector('button')!.textContent).toContain('First');
    send({ type: 'cursor', context: oldContext, offset: book.indexOf('CDEF') });
    expect(element<HTMLButtonElement>('play-from-here').disabled).toBe(true);
  });

  it('[SPEC-PLAY-12] 首次从第二首起播先验证目标，不被首曲错误阻断', async () => {
    const abc = `X:1\nK:wrong\n???\n\n${second}`;
    send({ ...snapshot(abc), initialRequest: { requestId: 1, offset: abc.indexOf('GABc') } });
    expect(element('tunes').querySelector('button')!.textContent).toContain('Second');
    expect(last('rendered').ok).toBe(true);
    expect(state.controller!.getStatus().phase).toBe('preparing');
    await flush();
    expect(synths).toHaveLength(1);
    send({ type: 'playback', viewId: 1, requestId: 2, action: 'stop' });
    synths[0].finish({ status: 'ok' });
    await flush();
    expect(synths[0].start).not.toHaveBeenCalled();
  });

  it('[SPEC-PLAY-12] 无效跨曲目标保持原音乐，有效目标切曲，待更新时拒绝起播', async () => {
    send(snapshot());
    await playing();
    send({ type: 'play-from-cursor', context: context(), requestId: 1, offset: book.indexOf('T:Second') });
    expect(synths[0].stop).not.toHaveBeenCalled();
    expect(last('linkage-unavailable').reason).toBe('no-mapping');
    send({ type: 'play-from-cursor', context: context(), requestId: 2, offset: book.indexOf('GABc') });
    expect(synths[0].stop).toHaveBeenCalled();
    expect(element('tunes').querySelector('button')!.textContent).toContain('Second');
    send(snapshot(book + '\n% updated', 2));
    send({ type: 'play-from-cursor', context: context(), requestId: 3, offset: book.indexOf('CDEF') });
    expect(last('linkage-unavailable').reason).toBe('update-pending');
  });

  it('[SPEC-PLAY-12] 新的无效源码起播取消未发声的旧准备意图', async () => {
    send(snapshot());
    send({ type: 'play-from-cursor', context: context(), requestId: 1, offset: book.indexOf('GABc') });
    await flush();
    send({ type: 'play-from-cursor', context: context(), requestId: 2, offset: book.indexOf('T:First') });
    synths[0].finish({ status: 'ok' });
    await flush();
    expect(synths[0].start).not.toHaveBeenCalled();
    expect(state.controller!.getStatus().phase).toBe('idle');
  });

  it('[SPEC-A11Y-04] [SPEC-DOC-01] 长标题安全呈现，Home/End只浏览，空格提交，外部取消不抢焦点', () => {
    const abc = first.replace('First', '<img src=x onerror=alert(1)>' + '长标题'.repeat(80)) + '\n\n' + second;
    send(snapshot(abc));
    const trigger = element('tunes').querySelector('button')!;
    trigger.click();
    const list = element('tune-list');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(list.getAttribute('aria-activedescendant')).toBe('tune-option-1');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(list.getAttribute('aria-activedescendant')).toBe('tune-option-0');
    expect(element('tunes').querySelector('img')).toBeNull();
    expect(element('tune-option-0').textContent).toContain('长标题'.repeat(80));
    element('score').focus();
    element('score').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(element('score'));
    expect(sent.filter((message) => message.type === 'select-tune')).toHaveLength(0);
    trigger.click();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(last('select-tune')).toBeDefined();
    expect(state.controller!.getStatus().phase).toBe('idle');
    expect(synths).toHaveLength(0);
  });

  it('[SPEC-L10N-01] 中文缺失标题/标识回退与确认按钮不显示资源键', () => {
    document.documentElement.lang = 'zh-cn';
    send(snapshot('X:\nK:C\nC|\n\nX:2\nK:C\nD|'));
    expect(element('tunes').textContent).toContain('无标题曲目');
    expect(element('tune-option-0').textContent).toContain('X:缺失');
    send(snapshot('K:C\nC|', 2));
    expect(element('confirm-tune').textContent).toBe('确认此曲目');
  });

  it('[SPEC-STATE-03] 失败参考谱保留真实旧曲归属，不标成刚选的坏曲', () => {
    const abc = `${first}\n\nX:2\nT:Broken\nK:wrong\n???`;
    send(snapshot(abc));
    choose(1, snapshot(abc));
    expect(element('content-status').textContent).toContain('Reference: Tune 1 / 2 · First · X:1 · version 1');
    expect(element<HTMLButtonElement>('play').disabled).toBe(true);
  });

  it('[SPEC-ENV-04] 停止和切曲后的旧 toggle/起播响应不能重新发声，目标变化取消旧往返', async () => {
    send(snapshot());
    const old = context();
    choose(1);
    send({ type: 'playback', viewId: 1, context: old, requestId: 1, action: 'toggle' });
    expect(synths).toHaveLength(0);
    send({ type: 'cursor', context: context(), offset: book.indexOf('GABc') });
    click('play-from-here');
    const request = last('play-from-selection-request');
    send({ type: 'cursor', context: context(), offset: book.indexOf('GABc') + 1 });
    send({ type: 'play-from-selection', context: context(), requestId: 2, targetRequestId: request.requestId });
    expect(synths).toHaveLength(0);
    await playing();
    const beforeStop = context();
    click('stop');
    send({ type: 'play-from-cursor', context: beforeStop, requestId: 3, offset: book.indexOf('CDEF') });
    send({ type: 'playback', viewId: 1, context: beforeStop, requestId: 4, action: 'toggle' });
    expect(state.controller!.getStatus().phase).toBe('idle');
    expect(synths).toHaveLength(1);
  });

  it('[SPEC-SET-04] 渲染失败保留旧设置，声部签名变化正式应用后清除整组静音', () => {
    const voices = 'X:1\nV:top name="旋律"\nV:low name="伴奏"\nK:C\n[V:top] CDEF|\n[V:low] C,4|';
    send(snapshot(voices));
    state.controller!.setSpeed(70);
    state.controller!.setLoopEnabled(true);
    state.controller!.setChordsMuted(true);
    state.controller!.setVoiceMuted(0, true);
    state.controller!.setVoiceMuted(1, true);
    send(snapshot('X:1\nK:wrong\n???', 2));
    send(snapshot(voices, 3));
    expect(state.controller!.getSettings().mutedVoices).toEqual([0, 1]);
    send(snapshot(voices.replace('旋律', '改名'), 4));
    expect(state.controller!.getSettings()).toEqual({ speed: 70, loop: true, chordsMuted: true, mutedVoices: [] });
    expect(element('content-status').textContent).toContain('Voices have changed');
    send(snapshot(voices, 5));
    expect(state.controller!.getSettings().mutedVoices).toEqual([]);
    expect(synths).toHaveLength(0);
  });

  it('[SPEC-DOC-02] 初始化意图只消费一次，取消选曲不重复报告无映射', () => {
    send({ ...snapshot(), initialRequest: { requestId: 1, offset: book.indexOf('GABc') } });
    element('tunes').querySelector('button')!.click();
    click('tune-option-0');
    click('stop');
    expect(sent.filter((message) => message.type === 'linkage-unavailable')).toHaveLength(0);
    expect(state.controller!.getStatus().phase).toBe('idle');
  });

  it('[SPEC-DOC-02] 同快照和纯标签刷新不重置设置、位置或选曲', () => {
    send(snapshot());
    choose(1);
    state.controller!.setSpeed(75);
    state.controller!.seekToFraction(0.5);
    const before = context();
    const position = state.controller!.getProgress().positionMs;
    send({ ...snapshot(), fileName: 'renamed.abc', isUntitled: true });
    expect(context()).toEqual(before);
    expect(state.controller!.getSpeed()).toBe(75);
    expect(state.controller!.getProgress().positionMs).toBe(position);
  });
});

describe('练习设置恢复与重置', () => {
  const practice = (ui: PracticeUiPreferences = { keyboardCollapsed: false, keyboardMode: 'tune' }) => ({
    version: 1 as const,
    ui,
    tunes: [{ id: '1', signature: null, settings: { speed: 70, loop: true, chordsMuted: true, mutedVoices: [0] } }],
  });

  it('[SPEC-SET-02] [SPEC-SET-03] [SPEC-SET-05] 首次推送恢复音乐设置与键盘偏好并回传', () => {
    send({ ...snapshot(), practice: practice({ keyboardCollapsed: true, keyboardMode: 'full' }) });
    expect(state.controller!.getSpeed()).toBe(70);
    expect(state.controller!.getLoopEnabled()).toBe(true);
    expect(state.controller!.getChordsMuted()).toBe(true);
    // 无可靠声部签名：保留速度 / 循环 / 伴奏，但清除静音并提示重新检查
    expect(state.controller!.getSettings().mutedVoices).toEqual([]);
    expect(element('content-status').textContent).toContain('Voices have changed');
    expect(element<HTMLSelectElement>('keyboard-range').value).toBe('full');
    expect(element('keyboard-scroll').hidden).toBe(true);
    const report = last('practice-state');
    expect(report.ui).toEqual({ keyboardCollapsed: true, keyboardMode: 'full' });
    // 核验后当前清单已知：记录改存本次计算的签名，静音保持清空
    expect(report.tunes).toEqual([{ id: '1', signature: '[[null,null]]', settings: { speed: 70, loop: true, chordsMuted: true, mutedVoices: [] } }]);
  });

  it('[SPEC-SET-03] [SPEC-SET-05] 设置与键盘偏好变化全量上报，未变化不重复提交', () => {
    send(snapshot());
    const initial = sent.filter((message) => message.type === 'practice-state').length;
    state.controller!.setSpeed(55);
    const afterSpeed = sent.filter((message) => message.type === 'practice-state').length;
    expect(afterSpeed).toBeGreaterThan(initial);
    expect(last('practice-state').tunes.find((tune) => tune.id === '1')!.settings.speed).toBe(55);
    state.controller!.setSpeed(55);
    expect(sent.filter((message) => message.type === 'practice-state')).toHaveLength(afterSpeed);
    click('keyboard-collapse');
    expect(last('practice-state').ui.keyboardCollapsed).toBe(true);
  });

  it('[SPEC-SET-04] 恢复的声部清单不一致时只清静音，不重置其他设置', () => {
    const voices = 'X:1\nV:top name="旋律"\nV:low name="伴奏"\nK:C\n[V:top] CDEF|\n[V:low] C,4|';
    send({
      ...snapshot(voices),
      practice: { version: 1, ui: { keyboardCollapsed: false, keyboardMode: 'tune' }, tunes: [
        { id: '1', signature: 'old-layout', settings: { speed: 60, loop: true, chordsMuted: true, mutedVoices: [0, 1] } },
      ] },
    });
    expect(state.controller!.getSettings()).toEqual({ speed: 60, loop: true, chordsMuted: true, mutedVoices: [] });
    expect(element('content-status').textContent).toContain('Voices have changed');
  });

  it('[SPEC-SET-07] 重置先暂停、恢复默认并清除本文件记录，不自动起播', async () => {
    send({ ...snapshot(), practice: practice({ keyboardCollapsed: true, keyboardMode: 'full' }) });
    await playing();
    click('reset-practice');
    expect(state.controller!.getStatus().phase).toBe('paused');
    expect(state.controller!.getSpeed()).toBe(100);
    expect(state.controller!.getLoopEnabled()).toBe(false);
    expect(state.controller!.getChordsMuted()).toBe(false);
    expect(state.controller!.getSettings().mutedVoices).toEqual([]);
    expect(element<HTMLSelectElement>('keyboard-range').value).toBe('tune');
    expect(element('keyboard-scroll').hidden).toBe(false);
    expect(last('reset-practice').context.viewId).toBe(1);
    const report = last('practice-state');
    expect(report.ui).toEqual({ keyboardCollapsed: false, keyboardMode: 'tune' });
    for (const tune of report.tunes) {
      expect(tune.settings).toEqual({ speed: 100, loop: false, chordsMuted: false, mutedVoices: [] });
    }
    // 重置不触发起播：最后上报的播放状态仍为暂停
    expect(last('playback-state').state).toBe('paused');
  });
});

describe('来源状态与可靠迁移', () => {
  it('[SPEC-LIFE-04] 迁移状态锁定播放与切曲，旧谱标注参考并提供目标入口', () => {
    send(snapshot());
    send({ type: 'source-state', viewId: 1, state: 'migrated', detail: 'moved.abc' });
    expect(element('content-status').textContent).toContain('This file was moved to moved.abc.');
    expect(element('content-status').textContent).toContain('reference only');
    expect(element<HTMLButtonElement>('play').disabled).toBe(true);
    expect(element<HTMLButtonElement>('play-from-here').disabled).toBe(true);
    expect(element('tunes').querySelector('button')!.disabled).toBe(true);
    expect(element('reveal-target').hidden).toBe(false);
    expect(element('reveal-source').hidden).toBe(true);
    // 其他实例的状态不影响本预览
    const before = element('content-status').textContent;
    send({ type: 'source-state', viewId: 9, state: 'available', detail: '' });
    expect(element('content-status').textContent).toBe(before);
    // 入口只回传实例编号，由宿主决定目标面板
    element<HTMLButtonElement>('reveal-target').click();
    expect(last('reveal-target').viewId).toBe(1);
  });

  it('[SPEC-LIFE-06] [SPEC-LIFE-07] 来源不可用锁定交互，恢复推送后解锁并按新内容归零', () => {
    send(snapshot());
    send({ type: 'source-state', viewId: 1, state: 'unavailable', detail: '/book.abc' });
    expect(element('content-status').textContent).toContain('The source file is unavailable: /book.abc.');
    expect(element<HTMLButtonElement>('play').disabled).toBe(true);
    send({ type: 'cursor', context: context(), offset: book.indexOf('CDEF') });
    expect(sent.filter((message) => message.type === 'target-ranges')).toHaveLength(0);
    // 宿主推送文档即视为来源恢复：解锁并强制按新版本重渲染
    send(snapshot(`${book}\n% resumed`, 2));
    expect(element<HTMLButtonElement>('play').disabled).toBe(false);
    expect(last('rendered').ok).toBe(true);
    expect(last('rendered').context.version).toBe(2);
  });

  it('[SPEC-LIFE-03] 可靠迁移只更新身份并保留设置与位置，不重渲染', () => {
    send(snapshot());
    state.controller!.setSpeed(70);
    state.controller!.seekToFraction(0.5);
    const before = context();
    const position = state.controller!.getProgress().positionMs;
    const renders = sent.filter((message) => message.type === 'rendered').length;
    send({ ...snapshot(), uri: 'file:///moved.abc', fileName: 'moved.abc', continued: true });
    expect(context()).toEqual(before);
    expect(state.controller!.getSpeed()).toBe(70);
    expect(state.controller!.getProgress().positionMs).toBe(position);
    expect(sent.filter((message) => message.type === 'rendered')).toHaveLength(renders);
  });

  it('[SPEC-LIFE-06] 磁盘缺失提示不锁定播放，清除后提示消失', () => {
    send(snapshot());
    send({ type: 'source-state', viewId: 1, state: 'disk-missing', detail: '/book.abc' });
    expect(element('content-status').textContent).toContain('The file is missing on disk (/book.abc); showing the open editor content.');
    expect(element<HTMLButtonElement>('play').disabled).toBe(false);
    send({ type: 'source-state', viewId: 1, state: 'available', detail: '' });
    expect(element('content-status').textContent).not.toContain('/book.abc');
  });
});

describe('解析诊断与问题入口', () => {
  const warningBook = 'X:1\nT:Warn\nK:C\nw: hello\nCDEF|';

  it('[SPEC-STATE-06] 告警显示摘要与可展开详情，可靠位置上报且不阻止播放', () => {
    send(snapshot(warningBook));
    expect(element('content-status-text').textContent).toContain('1 parse warning(s)');
    expect(element<HTMLDetailsElement>('diagnostics-details').hidden).toBe(false);
    expect(element('diagnostics-summary').textContent).toBe('Details');
    expect(element('diagnostics-list').textContent).toContain("Can't add words before the first line of music");
    // 位置前缀与 HTML 不进入用户可见详情（不编造行号）
    expect(element('diagnostics-list').textContent).not.toContain('Music Line:');
    const report = last('diagnostics');
    expect(report.items).toHaveLength(1);
    expect(warningBook.slice(report.items[0].start, report.items[0].end)).toBe('w');
    // 普通告警不阻止播放；查看问题只在可靠定位时出现，只回传实例编号
    expect(element<HTMLButtonElement>('play').disabled).toBe(false);
    expect(element('view-problems').hidden).toBe(false);
    click('view-problems');
    expect(sent.at(-1)).toEqual({ type: 'show-problems', viewId: 1 });
  });

  it('[SPEC-STATE-06] 新版本修复后诊断与入口一并清除', () => {
    send(snapshot(warningBook));
    expect(last('diagnostics').items).toHaveLength(1);
    send(snapshot('X:1\nT:Warn\nK:C\nCDEF|', 2));
    expect(last('diagnostics').items).toEqual([]);
    expect(element('diagnostics-details').hidden).toBe(true);
    expect(element('view-problems').hidden).toBe(true);
    expect(element('content-status-text').textContent).not.toContain('parse warning');
  });

  it('[SPEC-STATE-06] 只读来源页清除旧诊断并隐藏问题入口', () => {
    send(snapshot(warningBook));
    expect(last('diagnostics').items).toHaveLength(1);
    send({ type: 'source-state', viewId: 1, state: 'migrated', detail: 'moved.abc' });
    expect(last('diagnostics').items).toEqual([]);
    expect(element('diagnostics-details').hidden).toBe(true);
    expect(element('view-problems').hidden).toBe(true);
    expect(element<HTMLButtonElement>('play').disabled).toBe(true);
  });
});
