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
