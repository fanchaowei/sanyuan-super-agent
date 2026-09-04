import type { ModelMessage } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';

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

// ── Layer 2: Dynamic Tool Result Truncation ──────────

/** 工具结果截断所使用的字符数限制。 */
interface TruncationConfig {
  /** 单个工具输出允许保留的最大字符数。 */
  maxSingleResult: number;
  /** 所有消息内容合计允许占用的字符预算。 */
  contextBudgetChars: number;
}

const DEFAULT_TRUNCATION: TruncationConfig = {
  // 单个结果最多占上下文窗口的 50%；工具输出按约 2 字符/token 换算。
  maxSingleResult: Math.floor(CONTEXT_WINDOW * 0.5 * 2),
  // 全部消息最多占上下文窗口的 75%；整体内容按约 4 字符/token 换算。
  contextBudgetChars: Math.floor(CONTEXT_WINDOW * 0.75 * 4),
};

/**
 * 分两阶段缩减工具输出，避免大段工具结果挤占模型上下文。
 *
 * 第一阶段分别截断过大的输出并保留头尾；第二阶段在总量仍超预算时，
 * 从消息列表前端开始把旧工具输出替换成占位说明。原消息对象不会被直接修改。
 *
 * @returns 处理后的消息，以及被单独截断的输出数和被整体压缩的工具消息数。
 */
export function truncateToolResults(
  messages: ModelMessage[],
  config: TruncationConfig = DEFAULT_TRUNCATION,
): { messages: ModelMessage[]; truncated: number; compacted: number } {
  let truncated = 0;
  let compacted = 0;

  // 第一阶段：逐个检查工具输出，超限时保留前 60% 和后 40%。
  // 头部通常包含调用背景，尾部通常包含最终结果或错误，因此两端都需要保留。
  let result = messages.map(msg => {
    // 普通对话消息及非数组形式的内容不参与工具结果截断。
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((part: any) => {
      if (!part.output) return part;
      const outputText = toolResultOutputToText(part.output);
      if (outputText.length <= config.maxSingleResult) return part;

      truncated++;
      const maxChars = config.maxSingleResult;
      const headSize = Math.floor(maxChars * 0.6);
      const tailSize = Math.floor(maxChars * 0.4);
      const head = outputText.slice(0, headSize);
      const tail = outputText.slice(-tailSize);

      // 中间插入标记，既说明发生过截断，也保留截断前后的字符数信息。
      return {
        ...part,
        output: textToolResultOutput(`${head}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tail}`),
      };
    });

    return { ...msg, content: newContent };
  });

  // 第二阶段：统计第一阶段处理后的总字符数，判断是否仍超过整体预算。
  let totalChars = result.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + msg.content.length;
    if (Array.isArray(msg.content)) {
      return sum + (msg.content as any[]).reduce((s, p) =>
        s + (p.output ? toolResultOutputToText(p.output).length : (p.text as string)?.length || 0), 0);
    }
    return sum;
  }, 0);

  if (totalChars > config.contextBudgetChars) {
    // 消息通常按时间升序排列，因此从前向后优先清理最旧的工具结果。
    for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
      const msg = result[i];
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
      const toolName = ((msg.content as any[])[0])?.toolName || 'unknown';
      const oldSize = (msg.content as any[]).reduce((s: number, p: any) =>
        s + (p.output ? toolResultOutputToText(p.output).length : 0), 0);
      // 整条工具消息的输出都替换为简短占位符，同时保留消息及片段的其他字段。
      result[i] = {
        ...msg,
        content: (msg.content as any[]).map((p: any) => ({
          ...p,
          output: textToolResultOutput(`[compacted: ${toolName} output removed to free context]`),
        })),
      };
      // 使用移除前的输出大小更新预算，供循环判断是否需要继续压缩。
      totalChars -= oldSize;
      compacted++;
    }
  }

  return { messages: result, truncated, compacted };
}

// ── Layer 3: TTL Pruning ─────────────────────────────

/** 工具结果按存活时间（TTL）清理时使用的阈值。 */
interface TTLConfig {
  /** 触发软清理的消息年龄，单位为毫秒。 */
  softTTLMs: number;
  /** 触发硬清理的消息年龄，单位为毫秒。 */
  hardTTLMs: number;
  /** 软清理时分别保留的每段输出头部和尾部字符数。 */
  keepHeadTail: number;
}

// 这里指的时间年龄是指：该 message 与当前时间的时间差
const DEFAULT_TTL: TTLConfig = {
  softTTLMs: 5 * 60 * 1000, // 5 分钟后压缩较长输出的中部
  hardTTLMs: 10 * 60 * 1000, // 10 分钟后用过期占位符替换整个输出
  keepHeadTail: 1500, // 软清理时头部和尾部各保留 1500 个字符
};

/** TTL 清理后的消息列表及两种清理操作的数量。 */
export interface PruneResult {
  /** 处理后的消息；输入数组及原消息对象不会被直接修改。 */
  messages: ModelMessage[];
  /** 被软清理的工具输出片段数。 */
  softPruned: number;
  /** 被硬清理的工具消息数。 */
  hardPruned: number;
}

/**
 * 根据工具消息的年龄逐步释放上下文空间。
 *
 * 未达到软 TTL 的结果保持不变；达到软 TTL 后，较长输出只保留头尾；
 * 达到硬 TTL 后，整条工具消息的输出均替换为过期占位符。包含错误特征的
 * 工具结果不会被清理，以保留排障所需的信息。
 *
 * @param messages 按会话顺序排列的模型消息。
 * @param timestamps 消息索引到创建时间戳（毫秒）的映射。
 * @param config TTL 阈值与软清理保留长度。
 */
export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  config: TTLConfig = DEFAULT_TTL,
): PruneResult {
  const now = Date.now();
  let softPruned = 0;
  let hardPruned = 0;

  const result = messages.map((msg, idx) => {
    // 跳过用户和助手消息，只对结构化工具结果执行 TTL 清理。
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    // 时间戳以消息索引为键；未记录时间的消息无法判断年龄，因此原样保留。
    const ts = timestamps.get(idx);
    if (!ts) return msg;

    const age = now - ts;

    // 错误输出可帮助模型避免重复失败，因此即使过期也完整保留。
    const outputText = (msg.content as any[])
      .map((p: any) => p.output ? toolResultOutputToText(p.output) : '')
      .join('');
    const isError = /error|失败|不存在|denied|refused|timeout/i.test(outputText);
    if (isError) return msg;

    // 硬清理优先判断：达到硬 TTL 后，不再保留输出正文，只留下来源提示。
    if (age >= config.hardTTLMs) {
      hardPruned++;
      const toolName = (msg.content[0] as any)?.toolName || 'unknown';
      return {
        ...msg,
        content: msg.content.map((part: any) => ({
          ...part,
          output: textToolResultOutput(`[tool result expired: ${toolName}]`),
        })),
      };
    }

    // 软清理：仅处理足够长的输出，保留头尾并用说明文字替换中间部分。
    if (age >= config.softTTLMs) {
      const newContent = msg.content.map((part: any) => {
        if (!part.output) return part;
        const outputText = toolResultOutputToText(part.output);
        if (outputText.length <= config.keepHeadTail * 2) return part;

        softPruned++;
        const head = outputText.slice(0, config.keepHeadTail);
        const tail = outputText.slice(-config.keepHeadTail);
        const removed = outputText.length - config.keepHeadTail * 2;

        // 标出移除量和触发清理的 TTL，便于模型理解内容为何不完整。
        return {
          ...part,
          output: textToolResultOutput(`${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`),
        };
      });
      return { ...msg, content: newContent };
    }

    return msg;
  });

  return { messages: result, softPruned, hardPruned };
}

// ── Combined Defense ─────────────────────────────────

/** 上下文防御处理后的消息、token 估算值及各类缩减操作的统计。 */
export interface DefenseResult {
  /** 依次经过工具结果截断和 TTL 清理后的消息列表。 */
  messages: ModelMessage[];
  /** 根据最终消息内容估算出的 token 数量。 */
  tokenEstimate: number;
  /** 因单个输出过大而被截断的工具输出片段数。 */
  truncated: number;
  /** 因整体字符预算不足而被替换的工具消息数。 */
  compacted: number;
  /** 因达到软 TTL 而被保留头尾、移除中部的工具输出片段数。 */
  softPruned: number;
  /** 因达到硬 TTL 而被替换为过期提示的工具消息数。 */
  hardPruned: number;
}

/**
 * 按固定顺序执行完整的上下文防御流程。
 *
 * 先限制单个及整体工具输出的体积，再根据消息年龄清理旧工具结果，最后对
 * 已缩减的消息重新估算 token。前两步不会删除或重排消息，因此以消息索引为键
 * 的时间戳映射在 TTL 清理阶段仍然有效。
 *
 * @param messages 待处理的完整会话消息。
 * @param timestamps 消息索引到创建时间戳（毫秒）的映射。
 * @returns 最终消息、token 估算值及每种缩减操作的执行次数。
 */
export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  // 第 2 层：先限制过大的单个工具输出，并在必要时压缩旧工具结果。
  const trunc = truncateToolResults(messages);
  let result = trunc.messages;

  // 第 3 层：在截断结果上继续按消息年龄执行软清理或硬清理。
  const prune = ttlPrune(result, timestamps);
  result = prune.messages;

  // 第 1 层：以最终内容为准估算 token，避免返回缩减前的过时数值。
  const tokenEstimate = estimateMessageTokens(result);

  // 各计数器沿用所属处理层的统计粒度，不在此处重新计算。
  return {
    messages: result,
    tokenEstimate,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  };
}
