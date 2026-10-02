// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synth } from 'abcjs';
import type { PlaybackController } from '../src/webview/audio';
import { parseWebviewMessage, type DocumentMessage, type WebviewMessage } from '../src/core/messages';

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
