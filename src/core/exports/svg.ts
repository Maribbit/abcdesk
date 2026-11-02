/**
 * SVG export (SPEC-EXP-04 / 06): drives abcjs rendering on the Node side with a minimal DOM stub,
 * fully independent of preview / playback - no open preview or loaded soundfont required.
 * Output is a single file, black notation on white, viewable outside VS Code.
 */
import { loadAbcjs } from './abcjs';
import { StubElement, installStubDom, serializeStubTree } from './svg-dom';
import { tuneHasNotes } from './tunes';

/** Layout reference width (fixed, SPEC-EXP-06): unaffected by preview theme, window width, scroll or zoom state. */
const EXPORT_STAFF_WIDTH = 740;

/** Notation drawing color: replaces the abcjs currentColor placeholder so the viewer's color context does not matter. */
const EXPORT_PAINT_COLOR = '#000000';

/** Background color (SPEC-EXP-06 white): an SVG without background is unreadable on dark UIs. */
const EXPORT_BACKGROUND_COLOR = '#ffffff';

/** Export a single tune as SVG text (SPEC-EXP-06); returns undefined when there is no note content, never produces an empty shell (SPEC-EXP-08). */
export async function generateSvgText(abcText: string): Promise<string | undefined> {
  const abcjs = await loadAbcjs();
  const restoreDom = installStubDom();
  try {
    // Rendering and serialization are fully synchronous: no await while the stub is installed, no interleaving with other tasks
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

/** White background: insert a full-size background rect as the first (bottom-most) child. */
function addBackground(svg: StubElement): void {
  const background = new StubElement('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute('fill', EXPORT_BACKGROUND_COLOR);
  svg.insertBefore(background, svg.firstChild);
}

/** Integer height: abcjs derives a fractional height from content and some viewers / converters handle fractions inconsistently. */
function roundHeight(svg: StubElement): void {
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(height)) {
    svg.setAttribute('height', String(Math.ceil(height)));
  }
}
