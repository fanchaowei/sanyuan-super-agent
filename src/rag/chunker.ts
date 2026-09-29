export interface Chunk {
  /** 当前分块的稳定标识，格式为“来源#序号”。 */
  id: string;
  /** 分块实际包含的文本内容。 */
  text: string;
  /** 产生该分块的原始文档来源。 */
  source: string;
  /** 分块在当前文档中的零基序号。 */
  index: number;
  /** 根据字符数估算出的 token 数，供后续检索或上下文控制使用。 */
  tokenEstimate: number;
}

/** 每个分块期望容纳的 token 数。 */
const TARGET_TOKENS = 256;
/** 粗略的字符/token 换算比例，用于避免引入具体 tokenizer。 */
const CHARS_PER_TOKEN = 4;
/** 分块的目标字符数，由目标 token 数和换算比例推导得到。 */
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

/**
 * 将文档按段落、句子两级拆分为适合向量化和检索的文本分块。
 *
 * 处理流程：
 * 1. 先按连续换行拆分段落，并清理每个段落的首尾空白。
 * 2. 依次将普通段落合并到当前缓冲区，直到加入新段落会超过目标大小。
 * 3. 当前缓冲区超限时先生成一个分块；单个段落超限时，则改为按中英文句末标点拆分。
 * 4. 将句子逐个合并为不超过目标大小的分块，剩余内容继续留在缓冲区。
 * 5. 遍历结束后提交最后的缓冲区，并返回所有分块。
 *
 * @param source 文档来源或文件名，用于生成分块 ID 并保留溯源信息。
 * @param text 待切分的完整文档文本。
 * @returns 按原文顺序排列的分块数组。
 */
export function chunkDocument(source: string, text: string): Chunk[] {
  // 连续两个及以上换行视为段落边界，兼容常见 Markdown/纯文本格式。
  const paragraphs = text.split(/\n{2,}/);
  // 保存最终结果，保证分块顺序与输入文档一致。
  const chunks: Chunk[] = [];
  // 暂存尚未达到目标大小的文本。
  let current = '';
  // 下一个分块使用的零基序号。
  let idx = 0;

  // 逐段处理文档，优先保持段落完整性。
  for (const para of paragraphs) {
    // 去除段落首尾空白，避免空白字符占用分块容量。
    const trimmed = para.trim();
    // 空段落不产生分块，也不影响序号。
    if (!trimmed) continue;

    // 当前缓冲区与新段落（含段落分隔符）合并后超限时，先提交已有缓冲区。
    if (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0) {
      chunks.push(makeChunk(source, current.trim(), idx++));
      current = '';
    }

    // 单个段落本身超限时，退化为按句子切分，尽量保留语义边界。
    if (trimmed.length > TARGET_CHARS) {
      // 先提交此前缓存的段落，避免与超长段落混合。
      if (current.length > 0) {
        chunks.push(makeChunk(source, current.trim(), idx++));
        current = '';
      }
      // 同时识别中英文句末标点；句末后的空白作为分隔符被消耗。
      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/);
      // 暂存当前句子组，直到再加入一句会超过目标字符数。
      let sentBuf = '';
      // 依次聚合句子，确保每个句子组不超过目标大小（单句例外）。
      for (const sent of sentences) {
        if (sentBuf.length + sent.length + 1 > TARGET_CHARS && sentBuf.length > 0) {
          chunks.push(makeChunk(source, sentBuf.trim(), idx++));
          sentBuf = '';
        }
        // 句子之间使用单个空格连接，避免切分后文本黏连。
        sentBuf += (sentBuf ? ' ' : '') + sent;
      }
      // 超长段落剩余的句子组留在 current 中，交由后续段落或循环结束时提交。
      if (sentBuf.trim()) {
        current = sentBuf.trim();
      }
    } else {
      // 普通段落以两个换行拼接，保留原始段落层次并控制额外字符开销。
      current += (current ? '\n\n' : '') + trimmed;
    }
  }

  // 文档结束后提交最后一个尚未刷新的缓冲区。
  if (current.trim()) {
    chunks.push(makeChunk(source, current.trim(), idx++));
  }

  return chunks;
}

/**
 * 将文本和来源信息封装为标准 Chunk 对象。
 *
 * @param source 文档来源或文件名。
 * @param text 已完成切分、待封装的文本。
 * @param index 文本分块在文档中的零基序号。
 * @returns 带有 ID、溯源信息和 token 粗略估算值的分块对象。
 */
function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    // 组合来源和序号，形成跨文档可区分且可追溯的 ID。
    id: `${source}#${index}`,
    // 保留切分后的正文，不在此处重复修改内容。
    text,
    // 回填原始来源，供检索结果展示和定位。
    source,
    // 回填分块序号，便于恢复文档顺序。
    index,
    // 向上取整，避免低估文本可能占用的 token 数。
    tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}
