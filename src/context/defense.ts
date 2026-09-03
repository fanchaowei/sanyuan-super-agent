import type { ModelMessage } from 'ai';
import { toolResultOutputToText } from './tool-result-output.js';

// ── Layer 1: Token Estimation ────────────────────────

/**
 * 跟踪会话上下文的 token 使用量。
 *
 * API 返回的 prompt token 数作为校准基线；两次 API 响应之间，则用新增或被替换
 * 消息的字符数估算变化量。这样无需在每次修改消息列表后重新分词。
 */
export class TokenTracker {
  private lastPreciseCount = 0; // 上次 API 返回的精确值
  private pendingChars = 0; // 新增消息的字符数

  /** 使用最新的服务端统计值重新校准估算基线。 */
  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0; // 精确值到了，清零增量
  }

  /** 记录一条尚未包含在服务端精确统计中的消息。 */
  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  /** 批量记录新增消息。 */
  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  /**
   * 按替换前后的字符数差值修正增量；压缩上下文时该差值可以为负数。
   */
  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  /** 按平均每 4 个字符约 1 个 token 估算当前上下文大小。 */
  get estimatedTokens(): number {
    // 替换或压缩可能产生负增量，但总 token 数不应小于 0。
    return Math.max(0, this.lastPreciseCount + Math.ceil(this.pendingChars / 4));
  }

  /** 返回上下文占用比例，并在达到 75% 时提示上层采取压缩等措施。 */
  get status(): { tokens: number; percent: number; needsAction: boolean } {
    const tokens = this.estimatedTokens;
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100);
    return {
      tokens,
      percent,
      needsAction: percent >= 75,
    };
  }
}

const CONTEXT_WINDOW = 200_000;

/**
 * 统计一条模型消息中会进入上下文的主要文本表示。
 * 工具结果、工具输入分别转为文本和 JSON，以覆盖非字符串消息片段。
 */
function countMessageChars(message: ModelMessage): number {
  let chars = 0;
  if (typeof message.content === 'string') {
    return message.content.length;
  }
  if (!Array.isArray(message.content)) return chars;

  for (const part of message.content) {
    if ('text' in part && typeof part.text === 'string') {
      chars += part.text.length;
    } else if ('output' in part) {
      chars += toolResultOutputToText(part.output).length;
    } else if ('input' in part) {
      chars += JSON.stringify(part.input)?.length ?? 0;
    }
  }
  return chars;
}

function countMessagesChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += countMessageChars(message);
  }
  return chars;
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);
  // 中文通常比英文消耗更多 token，因此在字符估算结果上增加 20% 安全余量。
  return Math.ceil((chars / 4) * 1.2);
}
