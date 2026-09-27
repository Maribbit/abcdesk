import {
  synth,
  TimingCallbacks,
  type AudioTracks,
  type MidiBuffer,
  type NoteMapTrack,
  type NoteTimingEvent,
  type SynthOptions,
  type TuneObject,
} from 'abcjs';
import {
  SPEED_DEFAULT,
  beatHintFor,
  clampSpeed,
  collectVoices,
  hasChordTrack,
  type VoiceEntry,
} from './playback';

/**
 * 播放引擎（SPEC-PLAY-01 / 02 / 03 / 04 / 05 / 06 / 11 / 12 / 14、SPEC-STATE-04 / 07、SPEC-PERF-06 / 08、SPEC-ENV-07）：
 * - 先渲染谱面，首次明确播放才准备音频；准备成功后直接执行这次仍有效的请求，无需再点一次；
 * - 准备期间再次播放 / 暂停（含隐藏与预览接替触发的暂停）取消起播，晚到完成一律不得发声；
 * - 停止立即停音并回到开头；暂停保留位置；已准备资源可复用（本类合成器 + abcjs 内部音色缓存）；
 * - 内容更新的缓存与统一应用时机由 main 协调（SPEC-STATE-07）；本类经 setTune 采用新曲目并归零；
 * - 演奏时序（TimingCallbacks）与音频同源同时启动：事件回调供 main 更新播放高亮，
 *   setProgress + seek 成对完成定位（SPEC-PLAY-11 / 12；官方 SynthController 同款同步方式）；
 * - 浏览器要求用户与预览交互后才能恢复音频设备：未交互时提示"点击预览开始播放"、
 *   不因等待报超时，首次交互后自动继续仍然有效的起播（SPEC-PLAY-14）；
 * - 首版仅钢琴音色：音序映射统一为内置钢琴，绝不触发 abcjs 默认远程音色地址（SPEC-ENV-07）。
 *
 * 速度与静音（SPEC-PLAY-02 / 04 / 06）：
 * - 速度百分比为主控：时序按 warpedQpm 重建（事件毫秒数随速度缩放）、音频经顶层
 *   millisecondsPerMeasure 重建，基准取曲目无参自然速度（与 abcjs 官方 go() 同款，修复
 *   无 Q: 复合拍的音频 / 时序基准分歧）；位置一律按乐曲比例（含反复的实际演奏顺序）保持；
 * - 声部静音经 voicesOff / chordsOff 参数重建生效，只作用于发声轨，不改谱面与键盘提示；
 * - 参数重建不改相位：播放中完成后继续当前快照（状态区提示"正在应用速度"）、
 *   暂停 / 空闲静默重建（由用户手动播放）；期间出现暂停、停止、隐藏、关闭或播放接替时取消续播；
 * - abcjs 的程序化停源（seek / 重建 / 停止 / 暂停）与自然结束共用 onEnded 回调：
 *   重建与播放中 seek 经 pendingEndedIgnores 计数排除，其余由相位守卫兜底；
 *   自然结束后 abcjs 不清 isRunning（僵尸运行态），由本类主动 stop 清理。
 *
 * 仅 webview 内使用（浏览器环境）；宿主通信由 main.ts 经消息桥完成（见 docs/conventions.md）。
 */

export type PlaybackPhase = 'idle' | 'preparing' | 'playing' | 'paused';

/** 当前相位与状态区文案键（文案在 l10n.ts，由 main 渲染）。 */
export interface PlaybackStatus {
  phase: PlaybackPhase;
  statusKey: string | null;
}

/** 准备阶段时间上限：超时终止本次请求，晚到完成不得发声；等待用户交互期间不计时（SPEC-PERF-06 / PLAY-14；阈值待 SPEC-PERF-10 实测校准）。 */
const PREPARE_TIMEOUT_MS = 30_000;

/**
 * 首次交互后的恢复窗口（SPEC-PLAY-14）：进入缓冲生成的旧任务可能挂在音频恢复上，
 * 先给它一个自行恢复的窗口，仍未完成则重启准备（音色缓存命中，代价小）。
 */
const GESTURE_RECOVERY_MS = 300;

/** 首版仅钢琴音色（SPEC-ENV-07）。 */
const PIANO_INSTRUMENT = 'acoustic_grand_piano';

/** 一次音频准备任务；primeStarted 表示已进入缓冲生成（此后可能等待音频恢复，SPEC-PLAY-14）。 */
interface PrepareTask {
  primeStarted: boolean;
}

/** 参数（速度 / 静音）重建的进行中状态（SPEC-PLAY-02 / 04 / 06）：完成后按记录的乐曲比例恢复。 */
interface RebuildState {
  generation: number;
  /** 目标位置：乐曲比例（含反复的实际演奏顺序），重建期间经定位请求更新。 */
  fraction: number;
  /** 完成后是否续播（播放中发起为真；期间暂停、隐藏或停止则取消）。 */
  resume: boolean;
}

export class PlaybackController {
  private readonly soundfontUrl: string | undefined;
  private readonly onChange: () => void;
  private readonly onTimeline: (event: NoteTimingEvent | null) => void;
  /** 时序重建后的通知（SPEC-PLAY-04）：main 据此重取 getTimings（事件毫秒数随速度变化）。 */
  private readonly onTimingsChanged: () => void;
  private readonly synthOptions: SynthOptions;
  private synthInstance: MidiBuffer | undefined;
  private tune: TuneObject | undefined;
  private phase: PlaybackPhase = 'idle';
  private statusKey: string | null = null;
  /** 当前曲目的演奏时序（SPEC-PLAY-11 / 12）：播放高亮与定位映射共同依据；换版与变速时重建。 */
  private timer: TimingCallbacks | undefined;
  /** 待提交的起播定位（乐曲比例，SPEC-PLAY-12）：准备完成后从该位置起播；取消 / 停止 / 消费后丢弃。 */
  private pendingStartFraction: number | undefined;
  /** 当前曲目的音频缓冲已生成完毕，可直接 start()（"已准备资源可复用"，SPEC-PLAY-01）。 */
  private prepared = false;
  /** 任务代次：取消 / 接替 / 换版 / 超时后递增，晚到的准备完成按此丢弃（SPEC-PLAY-01）。 */
  private taskGeneration = 0;
  private prepareTimer: number | undefined;
  /** 自管音频设备：浏览器要求用户交互后才能恢复（SPEC-PLAY-14），统一创建并经 init 传给 abcjs。 */
  private audioContext: AudioContext | undefined;
  /** 预览内是否已发生过用户交互（平台音频恢复的前提，SPEC-PLAY-14）。 */
  private hasUserGesture = false;
  /** 当前准备任务：首次交互到达时据此判断旧任务是否已进入缓冲阶段。 */
  private currentTask: PrepareTask | undefined;
  /** 首次交互后的恢复窗口计时器；首次交互监听在触发后移除。 */
  private gestureRecoveryTimer: number | undefined;
  private gestureUnlock: (() => void) | undefined;
  /** 速度百分比（SPEC-PLAY-04）：默认 100%，主控时序与音频的重建。 */
  private speed = SPEED_DEFAULT;
  /** 静音声部索引集合（SPEC-PLAY-06）：跨版本保留，与当前声部清单失配时自然忽略。 */
  private readonly mutedVoices = new Set<number>();
  /** 自动和弦伴奏是否静音（SPEC-PLAY-06）：与显式 ABC 伴奏声部相互独立。 */
  private chordsMuted = false;
  /** 当前曲目的实际声部清单（SPEC-PLAY-06）：随换版重建。 */
  private voiceEntries: VoiceEntry[] = [];
  /** 是否含自动和弦伴奏（SPEC-PLAY-06 / 10）：用无静音参数的展开产物检测，不受当前静音状态影响。 */
  private chordTrackPresent = false;
  /** 进行中的参数重建；重建期间相位不变、由本状态记录目标位置与续播意图。 */
  private rebuild: RebuildState | undefined;
  /**
   * 待忽略的自然结束事件计数：abcjs 的程序化停源（重建 / 播放中 seek）同样触发 onEnded，
   * 这些事件先在此计数掉、不算自然结束；停止 / 暂停触发的 ended 由相位守卫兜底。
   * 只对"有效的运行中停源"加一（僵尸运行态的 stop 不再派发事件，加了会永久卡死计数）。
   */
  private pendingEndedIgnores = 0;

  constructor(
    options: { soundfontUrl?: string },
    onChange: () => void,
    onTimeline: (event: NoteTimingEvent | null) => void,
    onTimingsChanged: () => void,
  ) {
    this.soundfontUrl = options.soundfontUrl;
    this.onChange = onChange;
    this.onTimeline = onTimeline;
    this.onTimingsChanged = onTimingsChanged;
    this.synthOptions = {
      soundFontUrl: this.soundfontUrl,
      sequenceCallback: forcePianoInstrument,
    };
    this.installGestureUnlock();
  }

  getStatus(): PlaybackStatus {
    return { phase: this.phase, statusKey: this.statusKey };
  }

  /** 当前曲目的演奏时序事件（供 main 构建字符↔音符映射，SPEC-PLAY-11 / 12）；无渲染曲目时为空。 */
  getTimings(): NoteTimingEvent[] {
    return this.timer?.noteTimings ?? [];
  }

  /** 当前速度百分比（SPEC-PLAY-04）。 */
  getSpeed(): number {
    return this.speed;
  }

  /** 当前曲目的声部清单与静音状态（SPEC-PLAY-06）：清单随换版重建，静音跨版本保留。 */
  getVoices(): Array<VoiceEntry & { muted: boolean }> {
    return this.voiceEntries.map((entry) => ({ ...entry, muted: this.mutedVoices.has(entry.index) }));
  }

  /** 是否含自动和弦伴奏（SPEC-PLAY-06）：决定声部菜单是否提供和弦开关。 */
  hasChordAccompaniment(): boolean {
    return this.chordTrackPresent;
  }

  /** 自动和弦伴奏当前是否静音（SPEC-PLAY-06）：声部菜单的勾选状态依据。 */
  getChordsMuted(): boolean {
    return this.chordsMuted;
  }

  /** 带拍换算提示（SPEC-PLAY-04）：无法可靠换算时为 null（界面不显示猜测值）。 */
  getBeatHint(): number | null {
    const tune = this.tune;
    if (tune === undefined) {
      return null;
    }
    return beatHintFor(tune, this.speed);
  }

  /** 进度（SPEC-PLAY-05）：位置与总长为当前速度下（含反复）的实际演奏毫秒。 */
  getProgress(): { positionMs: number; totalMs: number } {
    const totalMs = this.totalMs();
    return { positionMs: Math.round(totalMs * this.currentFraction()), totalMs };
  }

  /**
   * 调整速度（SPEC-PLAY-04）：百分比主控、只调整试听；重建时序与音频并保持乐曲位置（含反复），
   * 播放中允许短暂缓冲后继续，暂停时重建不发声。
   */
  setSpeed(percent: number): void {
    const next = clampSpeed(percent);
    if (next === this.speed) {
      return;
    }
    this.speed = next;
    const tune = this.tune;
    if (tune !== undefined) {
      // 先按新速度重建时序（事件毫秒数随速度缩放；main 的映射随新时序刷新），再重建音频
      const fraction = this.rebuild?.fraction ?? this.currentFraction();
      this.buildTimer(tune, fraction);
      this.onTimingsChanged();
    }
    this.applyAudioParams();
    this.onChange();
  }

  /** 静音 / 恢复单个声部（SPEC-PLAY-06）：经重建生效、不自动续播；只作用于发声轨，不改谱面与提示。 */
  setVoiceMuted(index: number, muted: boolean): void {
    if (!Number.isInteger(index) || index < 0) {
      return;
    }
    if (muted) {
      if (this.mutedVoices.has(index)) {
        return;
      }
      this.mutedVoices.add(index);
    } else if (!this.mutedVoices.delete(index)) {
      return;
    }
    this.applyAudioParams();
    this.onChange();
  }

  /** 静音 / 恢复自动和弦伴奏（SPEC-PLAY-06）：与显式 ABC 伴奏声部相互独立。 */
  setChordsMuted(muted: boolean): void {
    if (this.chordsMuted === muted) {
      return;
    }
    this.chordsMuted = muted;
    this.applyAudioParams();
    this.onChange();
  }

  /** 采用渲染后的曲目（应用时机的换版，SPEC-STATE-07）；尚未渲染出曲目（undefined）时清空，不残留已失效版本。 */
  setTune(tune: TuneObject | undefined): void {
    if (tune === this.tune) {
      return;
    }
    // 换版归零：取消进行中的准备（旧任务完成不得发声），丢弃旧合成器与位置
    this.invalidateTask();
    this.adoptTune(tune);
    this.onChange();
  }

  /**
   * 从指定毫秒起播（"从此处播放"，SPEC-PLAY-12）：与普通播放共用准备、取消与接替规则；
   * 播放中执行时为内部定位后继续（SPEC-PLAY-02），不算用户暂停、不重新准备。
   */
  playFromMs(milliseconds: number): void {
    if (this.tune === undefined) {
      return;
    }
    this.playFromFraction(this.fractionOfMs(milliseconds));
  }

  /**
   * 定位到乐曲比例（SPEC-PLAY-05）：播放中执行一次定位并继续（拖动预览由界面层负责）；
   * 暂停 / 空闲时只改变下次起点，不发声、不重新起播。
   */
  seekToFraction(fraction: number): void {
    if (this.tune === undefined) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, fraction));
    if (this.rebuild !== undefined) {
      // 重建进行中：记入目标，完成后落在该处（不打断重建）
      this.rebuild.fraction = clamped;
      return;
    }
    const instance = this.synthInstance;
    if (this.phase === 'playing' && instance !== undefined) {
      if (instance.getIsRunning()) {
        // 播放中 seek 会先程序化停源（触发一次 ended），该事件不算自然结束
        this.pendingEndedIgnores += 1;
      }
      instance.seek(clamped, 'percent');
      this.timer?.setProgress(clamped, 'percent');
      return;
    }
    // 暂停 / 空闲：只改变下次起点；僵尸运行态（自然结束后 abcjs 不清 isRunning）先停，
    // 否则 seek 内部会经 _kickOffSound 直接起播（点击进度条不得因此重新起播）
    if (instance !== undefined) {
      if (instance.getIsRunning()) {
        try {
          instance.stop();
        } catch (error) {
          console.error('ABC Desk: stop before seek failed', error);
        }
      }
      instance.seek(clamped, 'percent');
    }
    this.pendingStartFraction = clamped;
    this.timer?.setProgress(clamped, 'percent');
  }

  /** 播放 / 暂停切换（按钮、命令与预览局部空格共用操作规则，SPEC-CMD-11）。 */
  toggle(): void {
    switch (this.phase) {
      case 'preparing':
        this.cancelPrepare();
        break;
      case 'playing':
        this.pauseInternal();
        break;
      case 'paused':
        this.startSound();
        break;
      case 'idle':
        this.startFromIdle();
        break;
    }
  }

  /** 暂停用于隐藏与预览接替（SPEC-PLAY-02）；准备中视为取消起播（SPEC-PLAY-01）。 */
  pause(): void {
    if (this.phase === 'preparing') {
      this.cancelPrepare();
      return;
    }
    if (this.phase === 'playing') {
      this.pauseInternal();
    }
  }

  /** 停止：取消起播与在建参数重建、立即停音、回到开头（SPEC-PLAY-03 / CMD-10）。 */
  stop(): void {
    this.invalidateTask();
    this.rebuild = undefined;
    this.pendingStartFraction = undefined;
    const instance = this.synthInstance;
    this.phase = 'idle'; // 先改相位：随后触发的 ended 事件不算自然结束
    if (instance !== undefined) {
      try {
        instance.stop(); // 立即停音；abcjs 内部清掉暂停位置，下次从开头开始
      } catch (error) {
        console.error('ABC Desk: stop failed', error);
      }
    }
    this.timer?.stop(); // 演奏时序归零，下次播放从头回调（SPEC-PLAY-03）
    this.statusKey = null;
    this.onTimeline(null); // 停止清除播放高亮（SPEC-PLAY-11）
    this.onChange();
  }

  /** webview 关闭时立即停音（面板销毁前的保险；保留上下文时隐藏不会触发此处）。 */
  dispose(): void {
    this.removeGestureUnlock();
    this.invalidateTask();
    this.rebuild = undefined;
    const instance = this.synthInstance;
    this.synthInstance = undefined;
    this.prepared = false;
    this.phase = 'idle';
    this.timer?.stop();
    this.timer = undefined;
    if (instance !== undefined) {
      try {
        instance.stop();
      } catch (error) {
        console.error('ABC Desk: stop on dispose failed', error);
      }
    }
  }

  private startFromIdle(): void {
    if (this.tune === undefined) {
      return;
    }
    if (this.rebuild !== undefined) {
      // 重建进行中：排队续播（完成后从记录位置开始）
      this.rebuild.resume = true;
      this.phase = 'playing';
      this.onChange();
      return;
    }
    if (this.prepared && this.synthInstance !== undefined) {
      this.startSound(); // 已准备资源可复用，直接起播（待提交的起点由 startSound 消费）
      return;
    }
    this.beginPrepare();
  }

  /** 从乐曲比例起播（SPEC-PLAY-12 / 05）：定位统一按比例记录（含反复的实际演奏顺序）。 */
  private playFromFraction(fraction: number): void {
    if (this.rebuild !== undefined) {
      // 重建进行中：并入当前重建目标并排队续播
      this.rebuild.fraction = fraction;
      this.rebuild.resume = true;
      this.phase = 'playing';
      this.onChange();
      return;
    }
    switch (this.phase) {
      case 'idle':
      case 'paused':
        if (this.prepared && this.synthInstance !== undefined) {
          this.startSound(fraction);
        } else {
          this.pendingStartFraction = fraction;
          this.beginPrepare();
        }
        break;
      case 'preparing':
        // 新的显式定位请求接替仍在准备的请求：旧目标不提交（SPEC-PLAY-01）
        this.cancelPrepare();
        this.pendingStartFraction = fraction;
        this.beginPrepare();
        break;
      case 'playing':
        this.seekToFraction(fraction);
        break;
    }
  }

  /**
   * 开始播放（SPEC-PLAY-01 / 02 / 04）：可选从乐曲比例起播，缺省时消费待提交的起点；
   * 播放中 seek 由音频层内部停源并重启，不得再调 start()（M0 实测：会双重发声）。
   */
  private startSound(fraction?: number): void {
    if (this.rebuild !== undefined) {
      // 重建进行中（如暂停态重建后用户恢复播放）：排队在重建完成后续播
      this.rebuild.resume = true;
      this.phase = 'playing';
      this.onChange();
      return;
    }
    const instance = this.synthInstance;
    if (instance === undefined) {
      return;
    }
    const target = fraction ?? this.pendingStartFraction;
    this.pendingStartFraction = undefined;
    this.phase = 'playing';
    if (target !== undefined) {
      const wasRunning = instance.getIsRunning();
      instance.seek(target, 'percent');
      if (!wasRunning) {
        // 非运行状态：seek 只记录位置，需显式开始
        instance.start();
      }
    } else {
      instance.start();
    }
    this.syncTimer(target);
    this.statusKey = null;
    this.onChange();
  }

  /** 同步演奏时序（SPEC-PLAY-11）：先按定位目标校正进度，再启动；与音频同源同时。 */
  private syncTimer(startFraction: number | undefined): void {
    const timer = this.timer;
    if (timer === undefined) {
      return;
    }
    if (startFraction !== undefined) {
      timer.setProgress(startFraction, 'percent');
    }
    timer.start();
  }

  private pauseInternal(): void {
    if (this.rebuild !== undefined) {
      // 重建进行中：取消续播意图并转为暂停（完成时停在记录位置，SPEC-PLAY-02）
      this.rebuild.resume = false;
      this.phase = 'paused';
      this.statusKey = null;
      this.onChange();
      return;
    }
    const instance = this.synthInstance;
    if (instance === undefined) {
      return;
    }
    this.phase = 'paused'; // 先改相位：pause() 内部停源触发的 ended 不算自然结束
    instance.pause();
    this.timer?.pause();
    this.onChange();
  }

  private cancelPrepare(): void {
    // 取消起播：保留最后已提交位置（准备不提交新位置，待准备的定位目标一并丢弃）
    this.invalidateTask();
    this.pendingStartFraction = undefined;
    this.phase = 'idle';
    this.statusKey = null;
    this.onChange();
  }

  /** 采用新曲目：丢弃旧合成器、旧时序与位置（归零），空闲等待下次明确播放。 */
  private adoptTune(tune: TuneObject | undefined): void {
    this.synthInstance = undefined;
    this.prepared = false;
    this.rebuild = undefined;
    this.tune = tune;
    this.phase = 'idle';
    this.statusKey = null;
    this.pendingStartFraction = undefined;
    this.timer?.stop(); // 旧版本时序停止（换版归零）
    this.voiceEntries = [];
    this.chordTrackPresent = false;
    if (tune !== undefined) {
      // 先补音高数据再建时序：时序事件在建构时克隆 midiPitches，晚补不会回填（键盘音域与播放高亮依据）
      const flattened = this.preparePitchData(tune);
      this.voiceEntries = collectVoices(tune);
      // 和弦轨检测用无静音参数的展开产物（chordsOff 时完全无轨；静音只改音量、不删音符）
      this.chordTrackPresent =
        flattened !== undefined && hasChordTrack(flattened.tracks, this.voiceEntries.length);
      this.timer = this.createTimer(tune);
    } else {
      this.timer = undefined;
    }
    this.onTimeline(null); // 换版清除播放高亮（新谱面由 main 重建映射，SPEC-PLAY-11）
  }

  /**
   * 补写音符元素的 midiPitches 并返回展开产物：abcjs 只经 setUpAudio（合成 / MIDI 路径）
   * 把音高写到音符元素上，而 TimingCallbacks 建构即克隆该数据；不先补一次则时序事件无音高，
   * 键盘音域与播放高亮落空。展开产物用于和弦伴奏检测（音高值不受乐器参数影响）。
   */
  private preparePitchData(tune: TuneObject): AudioTracks | undefined {
    try {
      return tune.setUpAudio({});
    } catch (error) {
      // 音高数据不可用：不阻断渲染与播放，仅键盘音域、播放高亮与和弦开关缺失
      console.error('ABC Desk: audio sequence setup failed', error);
      return undefined;
    }
  }

  /** 创建当前曲目的演奏时序（SPEC-PLAY-11 / 12）：速度基准与音频同源，事件回调交给 main 更新播放高亮。 */
  private createTimer(tune: TuneObject): TimingCallbacks | undefined {
    try {
      return new TimingCallbacks(tune, {
        // 速度调整经 qpm 传入（SPEC-PLAY-04）：事件毫秒数随速度缩放，与音频的每小节毫秒数一致
        qpm: this.warpedQpm(tune),
        eventCallback: (event) => {
          this.onTimeline(event);
          // 返回 undefined：结束时允许时序自停（返回 "continue" 才会续播，SPEC-PLAY-03 非循环自然结束）
          return undefined;
        },
      });
    } catch (error) {
      // 时序不可用：不阻断渲染与播放，仅无播放高亮（映射缺失由 main 按不可用处理）
      console.error('ABC Desk: timing callbacks setup failed', error);
      return undefined;
    }
  }

  /** 以当前速度重建演奏时序（SPEC-PLAY-04）：替换旧时序并记录目标比例，不启动（由起播路径启动）。 */
  private buildTimer(tune: TuneObject, fraction: number): void {
    this.timer?.stop();
    this.timer = this.createTimer(tune);
    this.timer?.setProgress(fraction, 'percent');
  }

  /** 速度调整后的每小节毫秒数（SPEC-PLAY-04）：与 abcjs 官方 SynthController 同式，基准取曲目无参自然速度。 */
  private warpedMillisecondsPerMeasure(tune: TuneObject): number {
    return (tune.millisecondsPerMeasure() * 100) / this.speed;
  }

  /** 速度调整后的每分钟拍数（TimingCallbacks 的 qpm）：由每小节毫秒数反推、取整。 */
  private warpedQpm(tune: TuneObject): number {
    const millisecondsPerMeasure = this.warpedMillisecondsPerMeasure(tune);
    return Math.round((tune.getBeatsPerMeasure() / millisecondsPerMeasure) * 60000);
  }

  /**
   * 应用速度 / 静音参数（SPEC-PLAY-02 / 04 / 06）：经内部重建生效，不视为用户暂停、不触发换版；
   * 播放中重建完成后继续当前快照，暂停 / 空闲时静默重建（由用户手动播放，不自动续播）。
   */
  private applyAudioParams(): void {
    if (this.tune === undefined) {
      return;
    }
    if (this.phase === 'preparing') {
      // 准备中：取消旧准备，按新参数重新准备，保留这次仍有效的起播目标
      const fraction = this.pendingStartFraction;
      this.cancelPrepare();
      this.pendingStartFraction = fraction;
      this.beginPrepare();
      return;
    }
    if (this.synthInstance === undefined && this.rebuild === undefined) {
      return; // 尚未准备：参数在下次准备时自然生效（beginPrepare 读取当前参数）
    }
    this.startRebuild(this.phase === 'playing');
  }

  /** 开始参数重建（SPEC-PLAY-02 / 04 / 06）：旧实例停音销毁，完成后按记录的乐曲比例恢复。 */
  private startRebuild(resume: boolean): void {
    const instance = this.synthInstance;
    const fraction = this.rebuild?.fraction ?? this.currentFraction();
    if (instance !== undefined) {
      if (this.phase === 'playing' && instance.getIsRunning()) {
        // 停源触发一次 ended：计数排除，不算自然结束（僵尸运行态不再派发事件，不计数）
        this.pendingEndedIgnores += 1;
      }
      try {
        instance.stop();
      } catch (error) {
        console.error('ABC Desk: stop for rebuild failed', error);
      }
      this.synthInstance = undefined;
      this.prepared = false;
    }
    // 作废旧重建（若有）：晚到的完成按代次丢弃、不发声
    this.currentTask = undefined;
    if (this.prepareTimer !== undefined) {
      window.clearTimeout(this.prepareTimer);
      this.prepareTimer = undefined;
    }
    const generation = ++this.taskGeneration;
    if (resume) {
      this.statusKey = 'applying-speed'; // 播放中重建：状态区提示短暂缓冲
    }
    this.rebuild = { generation, fraction, resume };
    this.beginRebuild(generation, fraction);
    this.onChange();
  }

  /** 参数重建的异步执行：以当前参数初始化新实例，完成后恢复位置与（按需）续播。 */
  private beginRebuild(generation: number, fraction: number): void {
    const tune = this.tune;
    if (tune === undefined) {
      this.rebuild = undefined;
      return;
    }
    if (this.soundfontUrl === undefined || !synth.supportsAudio()) {
      // 音色地址缺失或环境不支持：按能力降级（SPEC-STATE-04），保留最后可靠位置
      this.rebuild = undefined;
      this.phase = 'idle';
      this.pendingStartFraction = fraction;
      this.statusKey = 'audio-failed';
      this.onChange();
      return;
    }
    const audioContext = this.ensureAudioContext();
    this.armPrepareTimeout(generation);
    const instance = new synth.CreateSynth();
    void this.initSynth(tune, instance, audioContext)
      .then(() => instance.prime())
      .then((result) => {
        if (generation !== this.taskGeneration || this.rebuild?.generation !== generation) {
          // 已取消 / 被接替 / 已换版 / 已超时：晚到的完成不得发声（备用缓冲由 abcjs 内部缓存复用）
          try {
            instance.stop();
          } catch (error) {
            console.error('ABC Desk: stop of superseded rebuild failed', error);
          }
          return;
        }
        this.prepareTimer = undefined;
        if (result.status === 'empty') {
          // 没有可发声的音符：保持空闲，不进入播放（SPEC-STATE-05）
          this.rebuild = undefined;
          this.phase = 'idle';
          this.pendingStartFraction = undefined;
          this.statusKey = 'no-notes';
          this.onChange();
          return;
        }
        this.finishRebuild(generation, instance);
      })
      .catch((error: unknown) => {
        if (generation !== this.taskGeneration || this.rebuild?.generation !== generation) {
          return;
        }
        // 重建失败：保留最后可靠位置（下次播放从该处重试），仅状态区提示（SPEC-STATE-04）
        this.prepareTimer = undefined;
        this.rebuild = undefined;
        this.phase = 'idle';
        this.pendingStartFraction = fraction;
        this.statusKey = 'audio-failed';
        console.error('ABC Desk: audio rebuild failed', error);
        this.onChange();
      });
  }

  /** 参数重建完成：安装新实例、恢复记录位置；播放中发起的重建继续播放（SPEC-PLAY-02）。 */
  private finishRebuild(generation: number, instance: MidiBuffer): void {
    const rebuild = this.rebuild;
    if (rebuild === undefined || rebuild.generation !== generation) {
      try {
        instance.stop();
      } catch (error) {
        console.error('ABC Desk: stop of stale rebuild failed', error);
      }
      return;
    }
    this.rebuild = undefined;
    this.synthInstance = instance;
    this.prepared = true;
    this.pendingStartFraction = undefined; // 位置由实例与重建状态承载，清掉更早的残留起点
    instance.seek(rebuild.fraction, 'percent');
    this.timer?.setProgress(rebuild.fraction, 'percent');
    if (rebuild.resume) {
      instance.start();
      this.timer?.start();
      this.statusKey = null;
      this.onChange();
    }
  }

  /** 初始化合成器（首播准备与参数重建共用）：本地音色、静音参数与速度基准。 */
  private initSynth(
    tune: TuneObject,
    instance: MidiBuffer,
    audioContext: AudioContext | undefined,
  ): Promise<unknown> {
    const options: SynthOptions = {
      ...this.synthOptions,
      onEnded: () => this.handleEnded(),
    };
    if (this.mutedVoices.size > 0) {
      // 声部静音（SPEC-PLAY-06）：只把对应轨音量置 0，不改音符、不改谱面与键盘提示
      options.voicesOff = [...this.mutedVoices].sort((first, second) => first - second);
    }
    if (this.chordsMuted) {
      options.chordsOff = true;
    }
    return instance.init({
      visualObj: tune,
      audioContext,
      // 速度基准（SPEC-PLAY-04）：顶层 millisecondsPerMeasure 控制渲染速度（与官方 setWarp 同款）
      millisecondsPerMeasure: this.warpedMillisecondsPerMeasure(tune),
      options,
    });
  }

  /** 当前乐曲比例（0–1，含反复的实际演奏顺序）：播放 / 暂停取实时位置，其余取待提交起点。 */
  private currentFraction(): number {
    if (this.phase === 'playing' || this.phase === 'paused') {
      const total = this.totalMs();
      if (total > 0) {
        return Math.min(1, Math.max(0, (this.timer?.currentMillisecond() ?? 0) / total));
      }
    }
    return this.pendingStartFraction ?? 0;
  }

  /** 当前时序的演奏总长（毫秒）：末事件（type: 'end'）即结束点。 */
  private totalMs(): number {
    const timings = this.timer?.noteTimings;
    if (timings === undefined || timings.length === 0) {
      return 0;
    }
    return timings[timings.length - 1].milliseconds;
  }

  /** 毫秒 → 乐曲比例（SPEC-PLAY-05 / 12）：按当前时序总长换算并夹取。 */
  private fractionOfMs(milliseconds: number): number {
    const total = this.totalMs();
    if (total <= 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, milliseconds / total));
  }

  /** 递增任务代次并清理任务标记与计时器：旧准备的完成不再产生任何影响。 */
  private invalidateTask(): void {
    this.taskGeneration += 1;
    this.currentTask = undefined;
    if (this.prepareTimer !== undefined) {
      window.clearTimeout(this.prepareTimer);
      this.prepareTimer = undefined;
    }
    if (this.gestureRecoveryTimer !== undefined) {
      window.clearTimeout(this.gestureRecoveryTimer);
      this.gestureRecoveryTimer = undefined;
    }
  }

  /**
   * 布置准备 / 重建超时（SPEC-PERF-06 / 08 / PLAY-14）：用户尚未交互时处于等待交互而非准备失败，不报超时；
   * 交互后恢复系统准备的超时保护，长时间无结果才按超时规则处理：
   * 首播超时终止请求回空闲；参数重建超时进暂停并保留最后可靠位置（SPEC-PERF-08）。
   */
  private armPrepareTimeout(generation: number): void {
    this.prepareTimer = window.setTimeout(() => {
      const rebuilding = this.rebuild !== undefined && this.rebuild.generation === generation;
      if (generation !== this.taskGeneration || (!rebuilding && this.phase !== 'preparing')) {
        return;
      }
      if (!this.hasUserGesture) {
        // 等待用户交互：不判失败、提示保持；交互后再恢复计时（SPEC-PLAY-14）
        this.prepareTimer = undefined;
        return;
      }
      this.prepareTimer = undefined;
      if (rebuilding) {
        // 重建超时（SPEC-PERF-08）：进暂停并保留最后可靠位置；挂起的事件由相位守卫兜底
        const fraction = this.rebuild?.fraction ?? 0;
        this.rebuild = undefined;
        this.pendingStartFraction = fraction;
        this.timer?.setProgress(fraction, 'percent');
        this.phase = 'paused';
        this.statusKey = 'prepare-timeout';
        this.onChange();
        return;
      }
      // 准备超时：终止本次请求，再完成也不得发声（SPEC-PLAY-01 / PERF-06）
      this.invalidateTask();
      this.pendingStartFraction = undefined;
      this.phase = 'idle';
      this.statusKey = 'prepare-timeout';
      this.onChange();
    }, PREPARE_TIMEOUT_MS);
  }

  /** 创建或复用 AudioContext；创建失败按音频能力受限处理（SPEC-STATE-04）。 */
  private ensureAudioContext(): AudioContext | undefined {
    if (this.audioContext === undefined) {
      try {
        this.audioContext = new AudioContext();
      } catch (error) {
        console.error('ABC Desk: AudioContext creation failed', error);
      }
    }
    return this.audioContext;
  }

  /** 监听预览内的首次用户交互：恢复音频设备并在必要时重启挂起的准备（SPEC-PLAY-14）。 */
  private installGestureUnlock(): void {
    const unlock = (): void => {
      this.removeGestureUnlock();
      this.hasUserGesture = true;
      const context = this.audioContext;
      if (context !== undefined && context.state === 'suspended') {
        // 用户交互上下文是恢复音频设备的标准时机（按钮路径同款行为）
        void context.resume().catch(() => {});
      }
      if (this.phase !== 'preparing') {
        return;
      }
      if (this.statusKey === 'click-to-play') {
        // 交互已发生：等待提示切换为真实的准备阶段
        this.statusKey = 'preparing';
        this.onChange();
      }
      if (this.prepareTimer === undefined) {
        // 等待交互期间不计时；交互后恢复系统准备超时保护（SPEC-PERF-06）
        this.armPrepareTimeout(this.taskGeneration);
      }
      const task = this.currentTask;
      if (task === undefined || !task.primeStarted) {
        // 缓冲尚未开始：音频恢复后 prime 不再挂起，无需重启
        return;
      }
      // 缓冲阶段可能已挂起在音频恢复：先给旧任务一个自行恢复的窗口，仍未完成则重启准备
      window.clearTimeout(this.gestureRecoveryTimer);
      this.gestureRecoveryTimer = window.setTimeout(() => {
        this.gestureRecoveryTimer = undefined;
        if (this.currentTask === task && this.phase === 'preparing') {
          this.cancelPrepare();
          this.startFromIdle();
        }
      }, GESTURE_RECOVERY_MS);
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
    window.addEventListener('click', unlock, { capture: true, passive: true });
    this.gestureUnlock = unlock;
  }

  /** 移除首次交互监听（触发后或销毁时）。 */
  private removeGestureUnlock(): void {
    const unlock = this.gestureUnlock;
    if (unlock === undefined) {
      return;
    }
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
    window.removeEventListener('click', unlock, { capture: true });
    this.gestureUnlock = undefined;
  }

  private beginPrepare(): void {
    const tune = this.tune;
    if (tune === undefined) {
      return;
    }
    if (this.soundfontUrl === undefined || !synth.supportsAudio()) {
      // 音色地址缺失或环境不支持：按能力降级，不进入准备（SPEC-STATE-04）
      this.phase = 'idle';
      this.pendingStartFraction = undefined;
      this.statusKey = 'audio-failed';
      this.onChange();
      return;
    }
    const audioContext = this.ensureAudioContext();
    const generation = ++this.taskGeneration;
    const task: PrepareTask = { primeStarted: false };
    this.currentTask = task;
    this.phase = 'preparing';
    // 尚未交互且音频设备未恢复时明确提示等待，不静默停留（SPEC-PLAY-14）
    const awaitingGesture = !this.hasUserGesture && audioContext?.state === 'suspended';
    this.statusKey = awaitingGesture ? 'click-to-play' : 'preparing';
    this.onChange();
    this.armPrepareTimeout(generation);

    const instance = new synth.CreateSynth();
    void this.initSynth(tune, instance, audioContext)
      .then(() => {
        task.primeStarted = true; // 进入缓冲生成：此后可能等待音频恢复（SPEC-PLAY-14）
        return instance.prime();
      })
      .then((result) => {
        if (generation !== this.taskGeneration) {
          // 已取消 / 已接替 / 已换版 / 已超时的旧任务：不得发声（备用缓冲由 abcjs 内部缓存复用）
          return;
        }
        this.prepareTimer = undefined;
        if (result.status === 'empty') {
          // 没有可发声的音符：保持空闲，不进入播放（SPEC-STATE-05）
          this.phase = 'idle';
          this.pendingStartFraction = undefined;
          this.statusKey = 'no-notes';
          this.onChange();
          return;
        }
        this.synthInstance = instance;
        this.prepared = true;
        // 成功后执行这次仍有效的请求，无需再点一次（SPEC-PLAY-01）；起点由 startSound 消费
        this.startSound();
      })
      .catch((error: unknown) => {
        if (generation !== this.taskGeneration) {
          return;
        }
        // 音频准备失败：保留谱面，仅状态区提示；用户再次播放即发起新的重试请求（SPEC-STATE-04）
        this.prepareTimer = undefined;
        this.phase = 'idle';
        this.statusKey = 'audio-failed';
        this.synthInstance = undefined;
        this.prepared = false;
        console.error('ABC Desk: audio preparation failed', error);
        this.onChange();
      });
  }

  /**
   * 自然结束（非循环）：停音回到可播放状态并清除播放高亮；位置与再次播放语义待 P01，不补造默认。
   * 程序化停源（重建 / 播放中 seek）触发的 ended 先由计数排除，其余由相位守卫兜底；
   * abcjs 自然结束后不清 isRunning（僵尸运行态），这里主动 stop 清理，避免后续操作经 seek 误起播。
   */
  private handleEnded(): void {
    if (this.pendingEndedIgnores > 0) {
      this.pendingEndedIgnores -= 1;
      return; // 重建 / 播放中 seek 触发的 ended：不算自然结束
    }
    if (this.rebuild !== undefined) {
      return; // 重建进行中音频未在播放：到达的事件属于程序化停源
    }
    if (this.phase !== 'playing') {
      return; // 手动停止 / 暂停触发的 ended：状态已在对应方法处理
    }
    const instance = this.synthInstance;
    if (instance !== undefined) {
      try {
        instance.stop(); // 清理僵尸运行态（已结束的源不会再派发 ended）
      } catch (error) {
        console.error('ABC Desk: stop after ended failed', error);
      }
    }
    this.phase = 'idle';
    this.statusKey = null;
    this.onTimeline(null);
    this.onChange();
  }
}

/** 首版仅钢琴音色（SPEC-ENV-07）：统一各声部乐器指令，不修改 ABC 材料本身。 */
function forcePianoInstrument(noteMapTracks: NoteMapTrack[]): NoteMapTrack[] {
  for (const track of noteMapTracks) {
    for (const note of track) {
      note.instrument = PIANO_INSTRUMENT;
    }
  }
  return noteMapTracks;
}
