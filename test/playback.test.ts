import { readFileSync } from 'node:fs';
import { parseOnly, type AbcElem } from 'abcjs';
import { describe, expect, it } from 'vitest';
import {
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  beatHintFor,
  clampSpeed,
  collectVoices,
  formatClock,
  hasChordTrack,
  parseSpeedPercent,
} from '../src/webview/playback';

// 绑定见 docs/spec/play.md（PLAY-04 速度、PLAY-05 进度、PLAY-06 声部）；
// PLAY 域为 manual 验证（登记见 docs/manual-checks.md），测试标题额外引用条目以便覆盖校验。

describe('速度换算与解析（SPEC-PLAY-04）', () => {
  it('[SPEC-PLAY-04] 越界夹取到 25–200、取整，非数值回退默认', () => {
    expect(clampSpeed(10)).toBe(SPEED_MIN);
    expect(clampSpeed(0)).toBe(SPEED_MIN);
    expect(clampSpeed(-40)).toBe(SPEED_MIN);
    expect(clampSpeed(201)).toBe(SPEED_MAX);
    expect(clampSpeed(1000)).toBe(SPEED_MAX);
    expect(clampSpeed(72.4)).toBe(72);
    expect(clampSpeed(72.6)).toBe(73);
    expect(clampSpeed(SPEED_DEFAULT)).toBe(SPEED_DEFAULT);
    expect(clampSpeed(Number.NaN)).toBe(SPEED_DEFAULT);
  });

  it('[SPEC-PLAY-04] 输入解析：空值与非数字为 null（还原），越界夹取不判非法', () => {
    expect(parseSpeedPercent('')).toBeNull();
    expect(parseSpeedPercent('   ')).toBeNull();
    expect(parseSpeedPercent('abc')).toBeNull();
    expect(parseSpeedPercent('120%')).toBeNull();
    expect(parseSpeedPercent('25')).toBe(SPEED_MIN);
    expect(parseSpeedPercent('250')).toBe(SPEED_MAX);
    expect(parseSpeedPercent('-40')).toBe(SPEED_MIN);
    expect(parseSpeedPercent('12.5')).toBe(SPEED_MIN);
    expect(parseSpeedPercent('72.5')).toBe(73);
    expect(parseSpeedPercent(' 80 ')).toBe(80);
  });

  it('[SPEC-PLAY-04] 带拍提示：可靠换算时按速度缩放，曲中变速 / 非四分拍 / 无数据不显示', () => {
    const base = { getBeatLength: () => 0.25, getBpm: () => 120, tempoLocations: {} };
    expect(beatHintFor(base, 100)).toBe(120);
    expect(beatHintFor(base, 75)).toBe(90);
    expect(beatHintFor(base, 150)).toBe(180);
    // 曲首 Q:（键 0）视为统一速度（getBpm 已读 Q: 值）
    expect(beatHintFor({ getBeatLength: () => 0.25, getBpm: () => 132, tempoLocations: { 0: 132 } }, 100)).toBe(132);
    // 曲中变速：不显示猜测值
    expect(beatHintFor({ ...base, tempoLocations: { 0: 132, 5: 88 } }, 100)).toBeNull();
    expect(beatHintFor({ ...base, tempoLocations: { 3: 88 } }, 100)).toBeNull();
    // 非四分拍（复合拍等）：不换算
    expect(beatHintFor({ ...base, getBeatLength: () => 0.375 }, 100)).toBeNull();
    // 数据缺失：不显示
    expect(beatHintFor({ ...base, tempoLocations: undefined }, 100)).toBeNull();
  });
});

describe('进度时间显示（SPEC-PLAY-05）', () => {
  it('[SPEC-PLAY-05] 毫秒按 M:SS 显示，负值与非有限值按 0', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(12_000)).toBe('0:12');
    expect(formatClock(59_999)).toBe('0:59');
    expect(formatClock(204_000)).toBe('3:24');
    expect(formatClock(3_600_000)).toBe('60:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('声部清单（SPEC-PLAY-06）', () => {
  it('[SPEC-PLAY-06] 按演奏时序收集声部，名称取首个非空、跨行取最大计数', () => {
    const tune = {
      lines: [
        // 第一行：一个谱表两个声部，首声部有名、次声部无名
        { staff: [{ clef: { type: 'treble' }, voices: [{}, {}], title: ['Flute', undefined] }] },
        // TAB 谱表跳过，不计入声部
        { staff: [{ clef: { type: 'TAB' }, voices: [{}, {}, {}], title: ['T1', 'T2', 'T3'] }] },
        // 行内跨谱表继续计数；标题此前为空，此处补上非空名
        { staff: [{ clef: { type: 'treble' }, voices: [{}, {}], title: ['', ''] }, { clef: { type: 'bass' }, voices: [{}], title: ['Cello'] }] },
      ],
    };

    expect(collectVoices(tune)).toEqual([
      { index: 0, name: 'Flute' },
      { index: 1, name: null },
      { index: 2, name: 'Cello' },
    ]);
  });

  it('[SPEC-PLAY-06] 后续行的首个非空标题补上无名声部；空标题保持无名', () => {
    const tune = {
      lines: [
        { staff: [{ voices: [{}, {}] }] },
        { staff: [{ voices: [{}, {}], title: ['', 'Viola'] }] },
      ],
    };

    expect(collectVoices(tune)).toEqual([
      { index: 0, name: null },
      { index: 1, name: 'Viola' },
    ]);
    expect(collectVoices({})).toEqual([]);
  });
});

describe('和弦轨识别（SPEC-PLAY-06）', () => {
  it('[SPEC-PLAY-06] 和弦轨按 channel 等于声部数识别，鼓轨与无额外轨不误判', () => {
    const voices = [
      [{ cmd: 'program', channel: 0 }],
      [{ cmd: 'program', channel: 1 }],
    ];
    // 和弦轨 channel = 声部数（2）
    expect(hasChordTrack([...voices, [{ cmd: 'program', channel: 2 }]], 2)).toBe(true);
    // 鼓轨 channel = 声部数 + 1，不是和弦轨
    expect(hasChordTrack([...voices, [{ cmd: 'program', channel: 3, instrument: 128 }]], 2)).toBe(false);
    // 无额外轨
    expect(hasChordTrack(voices, 2)).toBe(false);
    // 额外轨首条不是 program（无和弦）
    expect(hasChordTrack([...voices, [{ cmd: 'note', channel: 2 }]], 2)).toBe(false);
    // 防御：非数组输入
    expect(hasChordTrack(undefined, 2)).toBe(false);
  });
});

// 用真实复杂材料补充结构桩测试：只解析与展开事件，不创建 AudioContext 或下载音色。
const originalSample = readFileSync(
  new URL('../samples/09-lanterns-on-the-tide.abc', import.meta.url),
  'utf8',
);

describe('09 原创曲目：多声部与混合拍号回归', () => {
  it('[SPEC-PLAY-06] 无解析告警，四声部各 49 小节且逐小节时值一致', () => {
    const tunes = parseOnly(originalSample);
    expect(tunes).toHaveLength(1);
    const tune = tunes[0];
    expect(tune.warnings ?? []).toEqual([]);
    expect(collectVoices(tune)).toEqual([
      { index: 0, name: '旋律' },
      { index: 1, name: '应答' },
      { index: 2, name: '织体' },
      { index: 3, name: '低音' },
    ]);
    const bars = Array.from({ length: 4 }, () => [] as number[]);
    const durations = [0, 0, 0, 0];
    const multipliers = [1, 1, 1, 1];
    const meters = new Set<string>();
    for (const line of tune.lines) {
      for (const [voiceIndex, staff] of (line.staff ?? []).entries()) {
        expect(staff.voices).toHaveLength(1);
        for (const meter of staff.meter?.value ?? []) {
          meters.add(`${meter.num}/${meter.den}`);
        }
        for (const item of staff.voices?.[0] ?? []) {
          if (item.el_type === 'note') {
            // abcjs 的连音时值另存在 tripletMultiplier；倚音不额外占用主音时值。
            const note = item as AbcElem;
            if (note.startTriplet !== undefined) {
              multipliers[voiceIndex] = note.tripletMultiplier ?? 1;
            }
            durations[voiceIndex] += item.duration * multipliers[voiceIndex];
            if (note.endTriplet) {
              multipliers[voiceIndex] = 1;
            }
          } else if (item.el_type === 'bar' && durations[voiceIndex] > 0) {
            bars[voiceIndex].push(durations[voiceIndex]);
            durations[voiceIndex] = 0;
          }
        }
      }
    }
    expect([...meters].sort()).toEqual(['3/4', '4/4', '6/8']);
    expect(durations).toEqual([0, 0, 0, 0]);
    for (const voiceBars of bars) {
      expect(voiceBars).toHaveLength(49);
      voiceBars.forEach((duration, index) => {
        // 实写 26–33 为 4/4，其余为 6/8 或 3/4（以全音符为时值单位）。
        expect(duration, `实写第 ${index + 1} 小节`).toBeCloseTo(index >= 25 && index < 33 ? 1 : 0.75);
      });
    }
  });

  it('[SPEC-PLAY-04] [SPEC-PLAY-05] 一二房反复与六段速度展开为约 108 秒的演奏', () => {
    const tune = parseOnly(originalSample)[0];
    const firstNote = tune.lines.flatMap((line) => line.staff?.[0].voices?.[0] ?? [])
      .find((item) => item.el_type === 'note');
    expect(firstNote).toBeDefined();
    const audio = tune.setUpAudio({});
    const firstOccurrences = audio.tracks[0].filter(
      (event) => event.cmd === 'note' && event.startChar === firstNote?.startChar,
    );
    expect(firstOccurrences).toHaveLength(2);
    // A 展开为 16 小节，其余五段各 8 小节；按段拍单位而非单一 BPM 计算参考时间。
    const expectedSeconds = 16 * 120 / 66 + 8 * 120 / 72 + 8 * 180 / 90
      + 8 * 240 / 108 + 8 * 120 / 66 + 8 * 120 / 56;
    // 与 CreateSynth.prime 同口径：tempo 的拍单位并不恒为四分音符，不能直接按 240 / BPM 换算。
    const secondsPerWholeNote = tune.millisecondsPerMeasure() / 1000 / tune.getBarLength();
    expect(audio.totalDuration * secondsPerWholeNote).toBeCloseTo(expectedSeconds, 3);
    for (const track of audio.tracks.slice(0, 4)) {
      const end = Math.max(...track.map((event) => event.cmd === 'note' ? event.start + event.duration : 0));
      expect(end * secondsPerWholeNote).toBeCloseTo(expectedSeconds, 3);
    }
  });

  it('[SPEC-PLAY-06] [SPEC-PLAY-10] 自动和弦独立成轨，静音应答与织体不影响旋律和低音', () => {
    const audio = parseOnly(originalSample)[0].setUpAudio({});
    expect(audio.tracks).toHaveLength(5);
    expect(hasChordTrack(audio.tracks, 4)).toBe(true);
    const muted = parseOnly(originalSample)[0].setUpAudio({ voicesOff: [1, 2], chordsOff: true });
    expect(muted.tracks).toHaveLength(4);
    expect(hasChordTrack(muted.tracks, 4)).toBe(false);
    expect(muted.totalDuration).toBeCloseTo(audio.totalDuration);
    muted.tracks.forEach((track, index) => {
      const notes = track.filter((event) => event.cmd === 'note');
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.some((note) => note.volume > 0)).toBe(index === 0 || index === 3);
    });
  });
});
