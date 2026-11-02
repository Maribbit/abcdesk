// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOnly, type NoteTimingEvent, type TuneObject } from 'abcjs';
import { PlaybackController } from '../src/webview/audio';
import { defaultMusicSettings } from '../src/core/tuneSession';

const state = vi.hoisted(() => ({ synths: [] as FakeSynth[], timers: [] as FakeTimer[] }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
class FakeSynth {
  initGate = deferred<unknown>();
  primeGate = deferred<{ status: string }>();
  options?: { options: { onEnded: () => void; voicesOff?: number[]; chordsOff?: boolean }; millisecondsPerMeasure: number };
  running = false;
  init = vi.fn((options: NonNullable<FakeSynth['options']>) => { this.options = options; return this.initGate.promise; });
  prime = vi.fn(() => this.primeGate.promise);
  start = vi.fn(() => { this.running = true; });
  stop = vi.fn(() => { this.running = false; });
  pause = vi.fn(() => { this.running = false; });
  seek = vi.fn();
  getIsRunning = () => this.running;
  constructor() { state.synths.push(this); }
}
class FakeTimer {
  noteTimings = [{ type: 'event', milliseconds: 0 }, { type: 'end', milliseconds: 1000 }] as NoteTimingEvent[];
  stop = vi.fn();
  start = vi.fn();
  pause = vi.fn();
  setProgress = vi.fn();
  currentMillisecond = () => 500;
  constructor(_tune: TuneObject, readonly options: { eventCallback: (event: NoteTimingEvent | null) => void }) { state.timers.push(this); }
}
vi.mock('abcjs', async (original) => {
  const real = await original<{ default: typeof import('abcjs') }>();
  return { ...real.default,
    TimingCallbacks: function (tune: TuneObject, options: FakeTimer['options']) { return new FakeTimer(tune, options); },
    synth: { supportsAudio: () => true, CreateSynth: function () { return new FakeSynth(); } },
  };
});
let controller: PlaybackController;
let onChange: ReturnType<typeof vi.fn<() => void>>;
let timeline: ReturnType<typeof vi.fn<(event: NoteTimingEvent | null) => void>>;
const tune = () => parseOnly('X:1\nM:4/4\nK:C\nCDEF|')[0];
async function ready(instance: FakeSynth) {
  instance.initGate.resolve({});
  await Promise.resolve();
  instance.primeGate.resolve({ status: 'ok' });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioContext', class { state = 'running'; });
  state.synths = [];
  state.timers = [];
  onChange = vi.fn();
  timeline = vi.fn();
  controller = new PlaybackController({ soundfontUrl: 'https://local.test/fonts/' }, onChange, timeline, vi.fn());
});
afterEach(() => { controller.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('audio ownership and atomic settings', () => {
  it('[SPEC-DOC-03] a new tune restores settings and timing in one step, prepares no audio, and switching stops the old instance immediately', async () => {
    controller.setTune(tune(), { speed: 70, loop: true, chordsMuted: true, mutedVoices: [0] });
    expect(state.synths).toHaveLength(0);
    expect(state.timers).toHaveLength(1);
    controller.toggle();
    const old = state.synths[0];
    await ready(old);
    expect(old.options?.options).toMatchObject({ voicesOff: [0], chordsOff: true });
    expect(controller.getStatus().phase).toBe('playing');
    controller.setTune(tune());
    expect(old.stop).toHaveBeenCalledOnce();
    expect(state.synths).toHaveLength(1);
    expect(controller.getSettings()).toEqual(defaultMusicSettings());
    expect(controller.getProgress().positionMs).toBe(0);
  });

  it('[SPEC-DOC-04] an old prepare cancelled after init does not prime, and its late completion does not start the new tune', async () => {
    controller.setTune(tune());
    controller.toggle();
    const old = state.synths[0];
    controller.setTune(tune());
    expect(old.stop).toHaveBeenCalledOnce();
    await ready(old);
    expect(old.prime).not.toHaveBeenCalled();
    expect(old.start).not.toHaveBeenCalled();
    expect(controller.getStatus().phase).toBe('idle');
  });

  it('[SPEC-DOC-04] old prime, timing and ended completions must not change the new tune state or highlighting', async () => {
    controller.setTune(tune());
    const oldTimer = state.timers[0];
    controller.toggle();
    const old = state.synths[0];
    old.initGate.resolve({});
    await Promise.resolve();
    expect(old.prime).toHaveBeenCalledOnce();
    controller.setTune(tune());
    controller.toggle();
    await ready(state.synths[1]);
    timeline.mockClear();
    onChange.mockClear();
    await ready(old);
    oldTimer.options.eventCallback(oldTimer.noteTimings[0]);
    old.options?.options.onEnded();
    expect(old.start).not.toHaveBeenCalled();
    expect(timeline).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(controller.getStatus().phase).toBe('playing');
  });

  it('[SPEC-DOC-04] completion and callbacks of an old speed rebuild cannot restore a tune already switched away', async () => {
    controller.setTune(tune());
    controller.toggle();
    await ready(state.synths[0]);
    controller.setSpeed(80);
    const rebuild = state.synths[1];
    const oldTimer = state.timers.at(-1)!;
    controller.setTune(tune(), { ...defaultMusicSettings(), loop: true });
    controller.toggle();
    await ready(state.synths[2]);
    timeline.mockClear();
    await ready(rebuild);
    rebuild.options?.options.onEnded();
    oldTimer.options.eventCallback(null);
    expect(rebuild.start).not.toHaveBeenCalled();
    expect(timeline).not.toHaveBeenCalled();
    expect(controller.getSettings().speed).toBe(100);
    expect(controller.getStatus().phase).toBe('playing');
    state.synths[2].options?.options.onEnded();
    expect(state.synths[2].start).toHaveBeenCalledTimes(2); // The new tune's loop is not swallowed by the old ended count
  });

  it('[SPEC-DOC-04] pause/stop/dispose immediately clean up an unfinished prepare, and its completion still cannot start playback', async () => {
    for (const action of ['pause', 'stop', 'dispose'] as const) {
      controller.setTune(tune());
      controller.toggle();
      const pending = state.synths.at(-1)!;
      pending.initGate.resolve({});
      await Promise.resolve();
      controller[action]();
      expect(pending.stop).toHaveBeenCalledOnce();
      await ready(pending);
      expect(pending.start).not.toHaveBeenCalled();
    }
  });

  it('[SPEC-PLAY-04] a rebuild freezes old timers; after a timeout cancels the old task an explicit retry is possible', async () => {
    window.dispatchEvent(new Event('click'));
    controller.setTune(tune());
    controller.toggle();
    await ready(state.synths[0]);
    const oldTimer = state.timers.at(-1)!;
    controller.setSpeed(80);
    const pending = state.synths.at(-1)!;
    timeline.mockClear();
    oldTimer.options.eventCallback(oldTimer.noteTimings[0]);
    expect(timeline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(pending.stop).toHaveBeenCalled();
    expect(controller.getStatus().phase).toBe('paused');
    controller.toggle();
    const retry = state.synths.at(-1)!;
    expect(retry).not.toBe(pending);
    await ready(retry);
    await ready(pending);
    expect(pending.prime).not.toHaveBeenCalled();
    expect(pending.start).not.toHaveBeenCalled();
    expect(controller.getStatus().phase).toBe('playing');
  });

  it('[SPEC-STATE-07] adjusting while preparing reports no intermediate idle state and cannot re-enter version switching', () => {
    controller.setTune(tune());
    controller.toggle();
    const phases: string[] = [];
    onChange.mockImplementation(() => phases.push(controller.getStatus().phase));
    controller.setSpeed(80);
    expect(phases).not.toContain('idle');
    expect(controller.getStatus().phase).toBe('preparing');
  });

  it('[SPEC-PLAY-02] old timers are void after stop; an old ended after pause/resume does not end the new playback', async () => {
    controller.setTune(tune());
    controller.toggle();
    const instance = state.synths[0];
    await ready(instance);
    controller.pause();
    controller.toggle();
    instance.options?.options.onEnded();
    expect(controller.getStatus().phase).toBe('playing');
    const oldTimer = state.timers.at(-1)!;
    controller.stop();
    timeline.mockClear();
    oldTimer.options.eventCallback(oldTimer.noteTimings[0]);
    expect(timeline).not.toHaveBeenCalled();
    controller.toggle();
    instance.options?.options.onEnded();
    expect(controller.getStatus().phase).toBe('playing');
  });
});
