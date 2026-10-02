/**
 * 渲染用最小 DOM stub（SPEC-EXP-04 / 06）：在 Node 侧驱动 abcjs `renderAbc` 产出 SVG，
 * 不依赖真实浏览器环境。安装到还原之间全程同步（无 await），不与扩展宿主其他代码交错。
 *
 * stub 只实现 abcjs 渲染路径实际访问的接口面；文本测量经 getBBox 估算
 * （宽度 ≈ 字符数 × 字号 × 0.6），与真实浏览器渲染结果对照一致。
 */

/** 估算文本宽度相对字号的系数（经验值，与浏览器渲染实测对照校准）。 */
const WIDTH_PER_CHAR_RATIO = 0.6;

/** 估算行高相对字号的系数。 */
const LINE_HEIGHT_RATIO = 1.2;

/** 未显式给出字号时的兜底值。 */
const FALLBACK_FONT_SIZE = 10;

/** stub 节点公共部分：子节点与挂接关系。 */
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

/** 文本节点 stub。 */
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

/** 元素节点 stub：属性表 + 内联样式表 + 估算测量。 */
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

  /** 交互事件注册在导出中没有意义，忽略（abcjs 点选初始化会调用）。 */
  addEventListener(): void {}

  removeEventListener(): void {}

  /** abcjs 只用 innerHTML 清空容器；其余写入不影响导出结果。 */
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

  /** 长谱收尾时 abcjs 经 parentElement 回收分组容器（svg.js closeGroup）。 */
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

/** stub document 的接口面（abcjs 渲染路径访问的最小集合）。 */
interface StubDocument {
  body: StubElement;
  createElement(tagName: string): StubElement;
  createElementNS(namespaceURI: string, tagName: string): StubElement;
  createTextNode(text: string): StubText;
  querySelector(selector: string): StubElement | null;
}

/** 安装 stub 到全局环境，返回还原函数；还原函数必须放在 finally 中调用。 */
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
  // abcjs 的渲染入口读取 navigator.userAgent，错误路径访问 window.console（renderer.js）
  defineGlobal('navigator', { userAgent: '' });
  defineGlobal('window', { console, addEventListener() {} });

  return () => {
    restoreGlobal('document', descriptors.document);
    restoreGlobal('window', descriptors.window);
    restoreGlobal('navigator', descriptors.navigator);
  };
}

/** 序列化选项。 */
export interface SerializeOptions {
  /** 把 abcjs 的 `currentColor` 占位替换为固定绘制色（SPEC-EXP-06 白底黑谱）；缺省保留原值。 */
  paintColor?: string;
}

/** 把 stub 节点树序列化为 SVG 文本（含 XML 转义与根元素 xmlns 补全）。 */
export function serializeStubTree(root: StubElement, options: SerializeOptions = {}): string {
  return serializeNode(root, true, options.paintColor);
}

function serializeNode(node: StubText | StubElement, isRoot: boolean, paintColor: string | undefined): string {
  if (node instanceof StubText) {
    return escapeXml(node.data);
  }
  const attributes: string[] = [];
  for (const [name, value] of node.attributes) {
    // 不携带脚本与事件处理器（SPEC-EXP-06）：abcjs 缓存的监听器也不写入导出文件
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
