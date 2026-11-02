/**
 * Minimal DOM stub for rendering (SPEC-EXP-04 / 06): drives abcjs `renderAbc` on the Node side to produce SVG
 * without a real browser. Everything between install and restore is synchronous (no await) so it never interleaves with other extension host code.
 *
 * The stub implements only the surface the abcjs render path actually touches; text measurement is estimated via getBBox
 * (width ~ character count x font size x 0.6), calibrated against real browser output.
 */

/** Estimated text width relative to font size (empirical, calibrated against browser rendering). */
const WIDTH_PER_CHAR_RATIO = 0.6;

/** Estimated line height relative to font size. */
const LINE_HEIGHT_RATIO = 1.2;

/** Fallback when no explicit font size is given. */
const FALLBACK_FONT_SIZE = 10;

/** Shared part of stub nodes: children and parent links. */
class StubNode {
  readonly childNodes: Array<StubText | StubElement> = [];
  parentNode: StubNode | undefined;

  get firstChild(): StubText | StubElement | undefined {
    return this.childNodes[0];
  }

  appendChild<T extends StubText | StubElement>(child: T): T {
    this.detach(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends StubText | StubElement>(
    child: T,
    reference: StubText | StubElement | undefined | null,
  ): T {
    this.detach(child);
    const index = reference === undefined || reference === null ? -1 : this.childNodes.indexOf(reference);
    if (index >= 0) {
      this.childNodes.splice(index, 0, child);
    } else {
      this.childNodes.push(child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild<T extends StubText | StubElement>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
    if (child.parentNode === this) {
      child.parentNode = undefined;
    }
    return child;
  }

  private detach(child: StubText | StubElement): void {
    if (child.parentNode !== undefined) {
      child.parentNode.removeChild(child);
    }
  }
}

/** Text node stub. */
export class StubText extends StubNode {
  data: string;

  constructor(text: string) {
    super();
    this.data = String(text);
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(value: string) {
    this.data = String(value);
  }
}

/** Element node stub: attribute map + inline style map + estimated measurement. */
export class StubElement extends StubNode {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly attributes = new Map<string, string>();
  style: Record<string, string> = {};

  constructor(namespaceURI: string | null, tagName: string) {
    super();
    this.namespaceURI = namespaceURI;
    this.tagName = tagName;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_namespace: string | null, name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  /** Event registration is meaningless for export and is ignored (abcjs click-selection setup calls it). */
  addEventListener(): void {}

  removeEventListener(): void {}

  /** abcjs only uses innerHTML to clear the container; other writes do not affect the export. */
  set innerHTML(value: string) {
    if (value === '') {
      this.childNodes.length = 0;
    }
  }

  get innerHTML(): string {
    return '';
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes.length = 0;
    if (value !== '') {
      this.appendChild(new StubText(value));
    }
  }

  get children(): StubElement[] {
    return this.childNodes.filter((child): child is StubElement => child instanceof StubElement);
  }

  /** When finishing a long score abcjs recycles group containers via parentElement (svg.js closeGroup). */
  get parentElement(): StubNode | undefined {
    return this.parentNode;
  }

  getBBox(): { x: number; y: number; width: number; height: number } {
    const fontSize = Number.parseFloat(this.attributes.get('font-size') ?? '') || FALLBACK_FONT_SIZE;
    const lines = this.textContent.split('\n');
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return {
      x: 0,
      y: 0,
      width: longest * fontSize * WIDTH_PER_CHAR_RATIO,
      height: fontSize * LINE_HEIGHT_RATIO * lines.length,
    };
  }
}

/** Surface of the stub document (the minimal set the abcjs render path accesses). */
interface StubDocument {
  body: StubElement;
  createElement(tagName: string): StubElement;
  createElementNS(namespaceURI: string, tagName: string): StubElement;
  createTextNode(text: string): StubText;
  querySelector(selector: string): StubElement | null;
}

/** Install the stub into the global environment and return a restore function; restore must be called in finally. */
export function installStubDom(): () => void {
  const descriptors = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };

  const body = new StubElement(null, 'body');
  const stubDocument: StubDocument = {
    body,
    createElement: (tagName) => new StubElement(null, tagName),
    createElementNS: (namespaceURI, tagName) => new StubElement(namespaceURI, tagName),
    createTextNode: (text) => new StubText(text),
    querySelector: (selector) => (selector === 'body' ? body : null),
  };
  defineGlobal('document', stubDocument);
  // The abcjs render entry reads navigator.userAgent and the error path touches window.console (renderer.js)
  defineGlobal('navigator', { userAgent: '' });
  defineGlobal('window', { console, addEventListener() {} });

  return () => {
    restoreGlobal('document', descriptors.document);
    restoreGlobal('window', descriptors.window);
    restoreGlobal('navigator', descriptors.navigator);
  };
}

/** Serialization options. */
export interface SerializeOptions {
  /** Replace the abcjs `currentColor` placeholder with a fixed drawing color (SPEC-EXP-06 black on white); keeps the original when omitted. */
  paintColor?: string;
}

/** Serialize the stub node tree to SVG text (with XML escaping and a root xmlns). */
export function serializeStubTree(root: StubElement, options: SerializeOptions = {}): string {
  return serializeNode(root, true, options.paintColor);
}

function serializeNode(node: StubText | StubElement, isRoot: boolean, paintColor: string | undefined): string {
  if (node instanceof StubText) {
    return escapeXml(node.data);
  }
  const attributes: string[] = [];
  for (const [name, value] of node.attributes) {
    // No scripts or event handlers are carried over (SPEC-EXP-06): listeners cached by abcjs are not written to the export
    if (/^on/i.test(name)) {
      continue;
    }
    attributes.push(`${name}="${escapeXml(resolvePaint(value, paintColor))}"`);
  }
  const styleText = Object.entries(node.style)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([name, value]) => `${name}:${resolvePaint(value, paintColor)}`)
    .join(';');
  if (styleText !== '') {
    attributes.push(`style="${escapeXml(styleText)}"`);
  }
  if (isRoot && !node.attributes.has('xmlns')) {
    attributes.push('xmlns="http://www.w3.org/2000/svg"');
  }
  const open = `<${node.tagName}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>`;
  const children = node.childNodes.map((child) => serializeNode(child, false, paintColor)).join('');
  return `${open}${children}</${node.tagName}>`;
}

function resolvePaint(value: string, paintColor: string | undefined): string {
  return paintColor === undefined ? value : value.replaceAll('currentColor', paintColor);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
  } else {
    Object.defineProperty(globalThis, name, descriptor);
  }
}
