// 导出核心模块的加固测试：曲目解析、文件名建议与 MIDI / SVG 生成的关键行为与边界。
// EXP 域的验收为 manual（登记见 docs/manual-checks.md），此处只覆盖可离屏验证的纯逻辑。
import { describe, expect, it } from 'vitest';
import { loadAbcjs } from '../src/core/exports/abcjs';
import { sanitizeFileNameStem, suggestExportFileName } from '../src/core/exports/filename';
import { generateMidiBytes } from '../src/core/exports/midi';
import { generateSvgText } from '../src/core/exports/svg';
import { listTunes, tuneHasNotes } from '../src/core/exports/tunes';

const MULTI_TUNE = `% leading comment
%%MIDI program 40
X:1
T:First Tune
C:Trad.
K:C
CDEF GABc |

X:2
T:Second Tune
K:G
GABc dedB |`;

const MIDI_HEADER = new Uint8Array([0x4d, 0x54, 0x68, 0x64]); // "MThd"

describe('listTunes 曲目解析', () => {
  it('多曲目返回按序的序号、X:、标题与递增的起始偏移', async () => {
    const tunes = await listTunes(MULTI_TUNE);
    expect(tunes.map((tune) => ({ sequence: tune.sequence, id: tune.id, title: tune.title }))).toEqual([
      { sequence: 1, id: '1', title: 'First Tune' },
      { sequence: 2, id: '2', title: 'Second Tune' },
    ]);
    expect(tunes[1].startPos).toBeGreaterThan(tunes[0].startPos);
  });

  it('每个曲目文本自包含：含自身 X: 行与文件级 %% 指令，且不含其他曲目', async () => {
    const tunes = await listTunes(MULTI_TUNE);
    expect(tunes[0].abc).toContain('X:1');
    expect(tunes[0].abc).not.toContain('Second Tune');
    expect(tunes[1].abc).toContain('X:2');
    expect(tunes[1].abc).not.toContain('First Tune');
    // 文件级指令已并入各曲目且只出现一次（不得再与公共头部重复拼接）
    for (const tune of tunes) {
      expect(tune.abc.match(/%%MIDI program 40/g)).toHaveLength(1);
    }
  });

  it('单曲与空白文本都返回一首（判空不能依赖曲目数量）', async () => {
    expect(await listTunes('X:1\nT:Solo\nK:C\nCDEF|')).toHaveLength(1);
    expect(await listTunes('')).toHaveLength(1);
  });
});

describe('tuneHasNotes 判空', () => {
  it('有音符为真，空白文本为假', async () => {
    const abcjs = await loadAbcjs();
    expect(tuneHasNotes(abcjs.parseOnly('X:1\nK:C\nCDEF GABc |]')[0])).toBe(true);
    expect(tuneHasNotes(abcjs.parseOnly('')[0])).toBe(false);
  });

  it('合法全休止符不算空白（rest 也是 note 条目）', async () => {
    const abcjs = await loadAbcjs();
    expect(tuneHasNotes(abcjs.parseOnly('X:1\nK:C\nz8 |]')[0])).toBe(true);
  });
});

describe('suggestExportFileName 命名建议', () => {
  it('已保存单曲使用源文件基本名', () => {
    expect(
      suggestExportFileName({
        documentStem: 'tunes',
        tuneTitle: 'Cooley',
        tuneCount: 1,
        tuneSequence: 1,
        extension: 'mid',
      }),
    ).toBe('tunes.mid');
  });

  it('未保存新文档使用曲名，无曲名用 Untitled', () => {
    expect(
      suggestExportFileName({ tuneTitle: 'My Reel', tuneCount: 1, tuneSequence: 1, extension: 'svg' }),
    ).toBe('My Reel.svg');
    expect(
      suggestExportFileName({ tuneTitle: '', tuneCount: 1, tuneSequence: 1, extension: 'svg' }),
    ).toBe('Untitled.svg');
  });

  it('多曲目附加序号与曲名；基本名已含曲名时不重复', () => {
    expect(
      suggestExportFileName({
        documentStem: 'tunes',
        tuneTitle: 'Second',
        tuneCount: 2,
        tuneSequence: 2,
        extension: 'mid',
      }),
    ).toBe('tunes 2 Second.mid');
    expect(
      suggestExportFileName({
        documentStem: 'Second',
        tuneTitle: 'Second',
        tuneCount: 2,
        tuneSequence: 2,
        extension: 'mid',
      }),
    ).toBe('Second 2.mid');
  });

  it('清洗控制字符与保留字符并压缩空白', () => {
    expect(sanitizeFileNameStem('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j');
    expect(sanitizeFileNameStem('tune\nname\t x')).toBe('tune name x');
    expect(sanitizeFileNameStem('   ')).toBe('');
  });

  it('超长基本名截断且不留尾随空格', () => {
    expect(sanitizeFileNameStem('x'.repeat(120))).toBe('x'.repeat(80));
    const spaced = sanitizeFileNameStem(`${'x'.repeat(79)} y`);
    expect(spaced.length).toBeLessThanOrEqual(80);
    expect(spaced.endsWith(' ')).toBe(false);
  });
});

describe('generateMidiBytes', () => {
  it('生成标准 MIDI 文件（MThd 头）', async () => {
    const bytes = await generateMidiBytes('X:1\nT:Tiny\nM:4/4\nL:1/8\nK:C\nCDEF GABc |]');
    expect(bytes?.slice(0, 4)).toEqual(MIDI_HEADER);
  });

  it('从多曲目确认的第 2 首自包含文本可直接生成', async () => {
    const tunes = await listTunes(MULTI_TUNE);
    const bytes = await generateMidiBytes(tunes[1].abc);
    expect(bytes?.slice(0, 4)).toEqual(MIDI_HEADER);
  });

  it('无音符内容不生成文件', async () => {
    await expect(generateMidiBytes('')).resolves.toBeUndefined();
  });
});

describe('generateSvgText', () => {
  it('生成白底黑谱的独立 SVG 文本', async () => {
    const svg = await generateSvgText('X:1\nT:Tiny\nM:4/4\nL:1/8\nK:C\nCDEF GABc |]');
    expect(svg).toBeDefined();
    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('#000000');
    expect(svg).not.toContain('currentColor');
    expect(svg).not.toContain('--vscode-');
  });

  it('不携带脚本与事件处理器', async () => {
    const svg = await generateSvgText('X:1\nT:Tiny\nK:C\nCDEF |]');
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/\son\w+=/);
  });

  it('多行长谱完整输出（内容不被截断）', async () => {
    const body = Array.from({ length: 9 }, () => 'GABc dedB | cBAG FED2 |').join('\n');
    const svg = await generateSvgText(`X:1\nT:Long\nM:4/4\nL:1/8\nK:G\n${body}|]`);
    const height = Number(/<svg[^>]*height="([0-9.]+)"/.exec(svg ?? '')?.[1]);
    expect(height).toBeGreaterThan(400);
  });

  it('无音符内容不生成空壳', async () => {
    await expect(generateSvgText('')).resolves.toBeUndefined();
  });

  it('导出后还原全局 DOM 环境', async () => {
    expect('document' in globalThis).toBe(false);
    await generateSvgText('X:1\nK:C\nCDEF |]');
    expect('document' in globalThis).toBe(false);
  });
});
