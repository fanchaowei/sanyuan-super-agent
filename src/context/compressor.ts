import { generateText, type ModelMessage } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';

/**
 * 不调用真实 tokenizer，按“约 4 个字符 = 1 个 token”估算上下文大小。
 * 这个估算只用于决定何时压缩，不代表模型最终产生的精确 token 数。
 */
function estimateTokens(messages: ModelMessage[]): number {
  // 先累计所有可见文本的字符数，最后统一除以 4 并向上取整。
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        // 普通 user/assistant 文本 part 直接统计 text 字段。
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length;
          // tool-result 没有统一的 text 字段，先转换成文本再统计长度。
        } else if ('output' in part) {
          chars += toolResultOutputToText(part.output).length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ── 第一层：微型压缩（Microcompact） ──────────────────
// 将较早的一次性工具结果替换为短标记，避免上下文不断增长；同时保留消息结构。

// 只清理返回值属于一次性消耗的工具结果。
const CLEARABLE_TOOLS = new Set([
  'read_file', 'bash', 'grep', 'glob', 'list_directory',
  'edit_file', 'write_file',
]);
// 最近的三个工具结果通常仍有上下文价值，因此始终保留。
const KEEP_RECENT_TOOL_RESULTS = 3;

/** 清理较早的工具结果，并返回新的消息数组和实际清理数量。 */
export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  let cleared = 0;
  const toolResultIndices: number[] = [];

  // 先记录所有 tool 消息的下标，后面才能按历史顺序保留最新结果。
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      toolResultIndices.push(i);
    }
  }

  // 超出保留数量的前部下标就是最旧、可优先清理的结果。
  const toClear = toolResultIndices.slice(
    0, Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS)
  );

  const result = messages.map((msg, idx) => {
    // 非目标消息直接复用原对象，避免不必要的复制。
    if (!toClear.includes(idx)) return msg;
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    // 一个 tool 消息可能包含多个 part；用首个 part 的 toolName 判断工具。
    const toolName = (msg.content[0] as any)?.toolName || 'unknown';
    if (!CLEARABLE_TOOLS.has(toolName)) return msg;

    cleared++;
    // 保留 toolCallId、toolName 等匹配信息，只替换 output 内容。
    return {
      ...msg,
      content: msg.content.map((part: any) => ({
        ...part,
        output: textToolResultOutput('[tool result cleared]'),
      })),
    };
  });

  return { messages: result, cleared };
}

// ── 第二层：大模型摘要压缩（LLM Summarization） ────────

// 系统提示词负责约束摘要的结构、语言、必保留信息和最大长度，
// 让生成的摘要可以在下一轮对话中替代较早的原始消息。
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

// 只有估算 token 达到阈值时才触发摘要，避免短对话产生不必要的模型调用。
const CONTEXT_TOKEN_THRESHOLD = 300;
// 最近消息保留原文，既保留当前对话细节，也降低摘要造成的信息损失。
const KEEP_RECENT_MESSAGES = 6;

/** 一次摘要压缩的结果。 */
export interface CompactionResult {
  /** 用摘要消息替换旧历史后的新消息列表。 */
  messages: ModelMessage[];
  /** 本次生成的摘要；未压缩时返回已有摘要或空字符串。 */
  summary: string;
  /** 被摘要替代的原始消息数量。 */
  compressedCount: number;
}

/**
 * 摘要压缩会把旧消息前缀替换成一条摘要消息，因此需要同步调整基于消息索引的时间戳。
 * compressedCount 为 0 时消息没有重排，直接复制原映射；否则新索引 0 属于摘要，
 * 后续消息依次对应旧列表中从 compressedCount 开始保留的消息。
 */
export function remapTimestampsAfterCompaction(
  timestamps: Map<number, number>,
  compressedCount: number,
  compactedMessageCount: number,
  summaryTimestamp = Date.now(),
): Map<number, number> {
  if (compressedCount === 0) return new Map(timestamps);

  const remapped = new Map<number, number>();
  remapped.set(0, summaryTimestamp);

  for (let newIndex = 1; newIndex < compactedMessageCount; newIndex++) {
    const oldIndex = compressedCount + newIndex - 1;
    const timestamp = timestamps.get(oldIndex);
    if (timestamp !== undefined) remapped.set(newIndex, timestamp);
  }

  return remapped;
}

/**
 * 使用大模型压缩较早的对话，并保留最近消息原文。
 * existingSummary 用于多次压缩：新摘要会同时吸收旧摘要和新增的历史消息。
 */
export async function summarize(
  model: any,
  messages: ModelMessage[],
  existingSummary?: string,
): Promise<CompactionResult> {
  // 未达到压缩阈值，或者消息总数不足以分出“旧历史”和“最近消息”时直接返回。
  const tokenEstimate = estimateTokens(messages);
  if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD || messages.length <= KEEP_RECENT_MESSAGES) {
    return { messages, summary: existingSummary || '', compressedCount: 0 };
  }

  // 初步切分点：列表末尾的 KEEP_RECENT_MESSAGES 条消息划入保留区。
  const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

  // 将切分点向前移动到 user 消息，避免把一轮“用户提问 → 助手回答 → 工具结果”
  // 从中间截断，否则摘要和保留区可能各自缺少必要的上下文。
  let alignedIdx = splitIdx;
  while (alignedIdx > 0 && messages[alignedIdx].role !== 'user') {
    alignedIdx--;
  }
  // 找不到可用的 user 边界时不压缩，以免破坏消息序列的语义。
  if (alignedIdx === 0) {
    return { messages, summary: existingSummary || '', compressedCount: 0 };
  }

  // 切分点之前交给模型摘要；切分点及之后保持原始内容。
  const toCompress = messages.slice(0, alignedIdx);
  const toKeep = messages.slice(alignedIdx);

  // 把不同结构的 ModelMessage 展平成人类可读文本，作为摘要模型的输入。
  const conversationText = toCompress
    .map(msg => {
      // content 可能是字符串，也可能是文本、工具结果等多个 part 组成的数组。
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(part => 'text' in part
            ? part.text
            : 'output' in part
              ? toolResultOutputToText(part.output)
              : '').join('')
          : '';
      // 保留消息角色，帮助摘要模型区分用户、助手和工具产生的内容。
      return content ? `**${msg.role}**: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  // 过滤后没有可摘要文本时不调用模型，避免生成无意义摘要。
  if (!conversationText.trim()) {
    return { messages, summary: existingSummary || '', compressedCount: 0 };
  }

  // 如果之前已经压缩过，将旧摘要与本次新增历史一起交给模型重新归纳，
  // 从而让多轮压缩后的摘要仍然包含最早的关键信息。
  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText;

  try {
    // COMPRESS_PROMPT 定义摘要规则，userPrompt 提供实际需要压缩的对话内容。
    const { text: summary } = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: userPrompt,
    });

    // 把摘要包装成一条 user 消息放在最前面，让后续模型能把它作为历史背景读取。
    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
    };

    // 新上下文由“一条摘要消息 + 最近未压缩消息原文”组成。
    const newMessages: ModelMessage[] = [summaryMessage, ...toKeep];

    return {
      messages: newMessages,
      summary,
      compressedCount: toCompress.length,
    };
  } catch (err) {
    // 摘要失败时回退到原消息，保证模型调用异常不会导致对话历史丢失。
    console.error('[Compaction] LLM 摘要失败:', err);
    return { messages, summary: existingSummary || '', compressedCount: 0 };
  }
}

export { estimateTokens };
