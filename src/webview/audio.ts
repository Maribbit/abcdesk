import { synth, type MidiBuffer, type NoteMapTrack, type SynthOptions, type TuneObject } from 'abcjs';

/**
 * 播放引擎（SPEC-PLAY-01 / 02 / 03 / 14、SPEC-STATE-04 / 07、SPEC-PERF-06、SPEC-ENV-07）：
 * - 先渲染谱面，首次明确播放才准备音频；准备成功后直接执行这次仍有效的请求，无需再点一次；
 * - 准备期间再次播放 / 暂停（含隐藏与预览接替触发的暂停）取消起播，晚到完成一律不得发声；
 * - 停止立即停音并回到开头；暂停保留位置；已准备资源可复用（本类合成器 + abcjs 内部音色缓存）；
 * - 内容更新的缓存与统一应用时机由 main 协调（SPEC-STATE-07）；本类经 setTune 采用新曲目并归零；
 * - 浏览器要求用户与预览交互后才能恢复音频设备：未交互时提示"点击预览开始播放"、
 *   不因等待报超时，首次交互后自动继续仍然有效的起播（SPEC-PLAY-14）；
 * - 首版仅钢琴音色：所有乐器指令统一为钢琴，绝不触发 abcjs 默认远程音色地址（SPEC-ENV-07）。
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

export class PlaybackController {
  private readonly soundfontUrl: string | undefined;
  private readonly onChange: () => void;
  private readonly synthOptions: SynthOptions;
  private synthInstance: MidiBuffer | undefined;
  private tune: TuneObject | undefined;
  private phase: PlaybackPhase = 'idle';
  private statusKey: string | null = null;
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

  constructor(options: { soundfontUrl?: string }, onChange: () => void) {
    this.soundfontUrl = options.soundfontUrl;
    this.onChange = onChange;
    this.synthOptions = {
      soundFontUrl: this.soundfontUrl,
      sequenceCallback: forcePianoInstrument,
    };
    this.installGestureUnlock();
  }

  getStatus(): PlaybackStatus {
    return { phase: this.phase, statusKey: this.statusKey };
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

  /** 停止：取消起播、立即停音、回到开头（SPEC-PLAY-03 / CMD-10）。 */
  stop(): void {
    this.invalidateTask();
    const instance = this.synthInstance;
    this.phase = 'idle'; // 先改相位：随后触发的 ended 事件不算自然结束
    if (instance !== undefined) {
      instance.stop(); // 立即停音；abcjs 内部清掉暂停位置，下次从开头开始
    }
    this.statusKey = null;
    this.onChange();
  }

  /** webview 关闭时立即停音（面板销毁前的保险；保留上下文时隐藏不会触发此处）。 */
  dispose(): void {
    this.removeGestureUnlock();
    this.invalidateTask();
    const instance = this.synthInstance;
    this.synthInstance = undefined;
    this.prepared = false;
    this.phase = 'idle';
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
    if (this.prepared && this.synthInstance !== undefined) {
      this.startSound(); // 已准备资源可复用，直接起播
      return;
    }
    this.beginPrepare();
  }

  private startSound(): void {
    if (this.synthInstance === undefined) {
      return;
    }
    this.phase = 'playing';
    this.synthInstance.start();
    this.statusKey = null;
    this.onChange();
  }

  private pauseInternal(): void {
    const instance = this.synthInstance;
    if (instance === undefined) {
      return;
    }
    this.phase = 'paused'; // 先改相位：pause() 内部停源触发的 ended 不算自然结束
    instance.pause();
    this.onChange();
  }

  private cancelPrepare(): void {
    // 取消起播：保留最后已提交位置（准备不提交新位置，位置保持原值）
    this.invalidateTask();
    this.phase = 'idle';
    this.statusKey = null;
    this.onChange();
  }

  /** 采用新曲目：丢弃旧合成器与位置（归零），空闲等待下次明确播放。 */
  private adoptTune(tune: TuneObject | undefined): void {
    this.synthInstance = undefined;
    this.prepared = false;
    this.tune = tune;
    this.phase = 'idle';
    this.statusKey = null;
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
   * 布置准备超时（SPEC-PERF-06 / PLAY-14）：用户尚未交互时处于等待交互而非准备失败，不报超时；
   * 交互后恢复系统准备的超时保护，长时间无结果才按超时规则处理。
   */
  private armPrepareTimeout(generation: number): void {
    this.prepareTimer = window.setTimeout(() => {
      if (this.phase !== 'preparing' || generation !== this.taskGeneration) {
        return;
      }
      if (!this.hasUserGesture) {
        // 等待用户交互：不判失败、提示保持；交互后再恢复计时（SPEC-PLAY-14）
        this.prepareTimer = undefined;
        return;
      }
      // 准备超时：终止本次请求，再完成也不得发声（SPEC-PLAY-01 / PERF-06）
      this.invalidateTask();
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
    void instance
      .init({
        visualObj: tune,
        audioContext,
        options: { ...this.synthOptions, onEnded: () => this.handleEnded() },
      })
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
          this.statusKey = 'no-notes';
          this.onChange();
          return;
        }
        this.synthInstance = instance;
        this.prepared = true;
        this.startSound(); // 成功后直接执行这次仍有效的请求，无需再点一次（SPEC-PLAY-01）
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

  /** 自然结束（非循环）：停音回到可播放状态；位置与再次播放语义待 P01，不补造默认。 */
  private handleEnded(): void {
    if (this.phase !== 'playing') {
      return; // 手动停止 / 暂停触发的 ended：状态已在对应方法处理
    }
    this.phase = 'idle';
    this.statusKey = null;
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
