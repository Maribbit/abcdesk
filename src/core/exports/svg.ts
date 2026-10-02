/**
 * SVG 导出（SPEC-EXP-04 / 06）：Node 侧用最小 DOM stub 驱动 abcjs 渲染，
 * 与预览 / 播放完全独立，不要求先打开预览或加载音色。
 * 输出单文件、白底黑谱，可脱离 VS Code 显示。
 */
import { loadAbcjs } from './abcjs';
import { StubElement, installStubDom, serializeStubTree } from './svg-dom';
import { tuneHasNotes } from './tunes';

/** 排版基准宽度（固定值，SPEC-EXP-06）：不受预览主题、窗口宽度、滚动或缩放状态影响。 */
const EXPORT_STAFF_WIDTH = 740;

/** 谱面绘制色：替换 abcjs 的 currentColor 占位，不依赖查看器的颜色上下文。 */
const EXPORT_PAINT_COLOR = '#000000';

/** 背景色（SPEC-EXP-06 白底）：无背景的 SVG 在暗色界面上会不可读。 */
const EXPORT_BACKGROUND_COLOR = '#ffffff';

/** 导出单曲 SVG 文本（SPEC-EXP-06）；无音符内容时返回 undefined，不生成空壳（SPEC-EXP-08）。 */
export async function generateSvgText(abcText: string): Promise<string | undefined> {
  const abcjs = await loadAbcjs();
  const restoreDom = installStubDom();
  try {
    // 渲染与序列化全程同步：stub 安装期间不跨 await，不与其他任务交错
    const host = new StubElement(null, 'div');
    const tunes = abcjs.renderAbc(host as unknown as HTMLElement, abcText, {
      staffwidth: EXPORT_STAFF_WIDTH,
    });
    const tune = tunes[0];
    if (tune === undefined || !tuneHasNotes(tune)) {
      return undefined;
    }
    const svg = host.children.find((child) => child.tagName === 'svg');
    if (svg === undefined) {
      throw new Error('abcjs did not produce an SVG element');
    }
    addBackground(svg);
    roundHeight(svg);
    return serializeStubTree(svg, { paintColor: EXPORT_PAINT_COLOR });
  } finally {
    restoreDom();
  }
}

/** 白底：插入首个（最底层）占满根尺寸的背景矩形。 */
function addBackground(svg: StubElement): void {
  const background = new StubElement('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute('fill', EXPORT_BACKGROUND_COLOR);
  svg.insertBefore(background, svg.firstChild);
}

/** 高度取整：abcjs 按内容推算的高度为小数，部分查看器 / 图像转换对小数高度处理不一致。 */
function roundHeight(svg: StubElement): void {
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(height)) {
    svg.setAttribute('height', String(Math.ceil(height)));
  }
}
