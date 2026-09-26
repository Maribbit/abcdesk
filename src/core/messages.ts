/**
 * 消息桥消息形状校验（SPEC-ENV-04）：宿主侧不信任 webview 消息。
 *
 * 纯逻辑模块：按消息类型校验并只提取已知字段；未知类型、缺类型或非对象一律拒绝。
 * 数值范围与当前文档版本校验在出现对应消息类型（播放控制等）时扩展。
 */

export interface WebviewReadyMessage {
  type: 'ready';
}

export type WebviewMessage = WebviewReadyMessage;

/** 解析 webview 消息：只接受形状完整的已登记类型，丢弃额外字段。 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') {
    return { type: 'ready' };
  }
  return undefined;
}
