/** 模拟向量和远程模型统一使用的向量维度。 */
const DIMS = 128;

/** 文本嵌入函数：接收多段文本，并按输入顺序返回对应向量。 */
export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

/**
 * 创建基于确定性字符哈希的模拟嵌入器，便于本地开发和测试。
 *
 * 处理流程：接收一批文本，逐条交给 {@link mockEmbed} 生成固定维度向量，
 * 最后按输入顺序返回向量数组。
 *
 * @returns 与远程嵌入器具有相同调用签名的模拟函数。
 */
export function createMockEmbedder(): EmbeddingFn {
  // 使用 map 保持批量输入与输出的一一对应关系。
  return async (texts: string[]) => texts.map(mockEmbed);
}

/**
 * 创建调用阿里云 DashScope text-embedding-v3 的真实嵌入器。
 *
 * 处理流程：接收一批文本 → 组装为 embeddings API 请求 → 校验 HTTP 响应 →
 * 从响应的 `data` 数组中提取每条文本对应的向量。
 *
 * @param apiKey DashScope API 访问密钥。
 * @returns 封装远程 HTTP 请求的嵌入函数。
 */
export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
  // 保持与 EmbeddingFn 一致，以便调用方可无缝切换模拟和真实实现。
  return async (texts: string[]) => {
    // 向 DashScope 兼容 OpenAI 的 embeddings 接口提交批量文本。
    const resp = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-v3',
          input: texts,
          dimensions: DIMS,
        }),
      },
    );
    // 非 2xx 响应包含服务端错误正文，便于定位鉴权或配额问题。
    if (!resp.ok) {
      throw new Error(`Embedding API error: ${resp.status} ${await resp.text()}`);
    }
    // API 返回结构与 OpenAI embeddings 格式兼容；此处提取每条结果的向量。
    const data = await resp.json() as any;
    return data.data.map((d: any) => d.embedding as number[]);
  };
}

/** 按原始文本缓存嵌入结果，避免重复请求相同内容。 */
const embedCache = new Map<string, number[]>();

/**
 * 为文本批量生成嵌入，并优先复用进程内缓存。
 *
 * 处理流程：
 * 1. 逐条查询文本缓存，将命中项直接写入结果数组。
 * 2. 收集未命中项及其原始索引，仅对未命中文本调用实际嵌入函数。
 * 3. 将新生成的向量回填到原始索引位置，并写入缓存。
 * 4. 返回与输入文本顺序一致的完整向量数组。
 *
 * @param fn 实际执行嵌入计算或远程请求的函数。
 * @param texts 待嵌入的文本列表。
 * @returns 与输入顺序一致的向量列表。
 */
export async function embed(fn: EmbeddingFn, texts: string[]): Promise<number[][]> {
  // 预分配结果数组，使缓存命中和未命中结果都能回填到原始位置。
  const results: number[][] = new Array(texts.length);
  // 记录缓存未命中的文本及其索引，后续只对这些文本调用嵌入函数。
  const uncached: { idx: number; text: string }[] = [];

  // 逐项检查缓存，同时保留输入索引以恢复输出顺序。
  for (let i = 0; i < texts.length; i++) {
    // 当前文本对应的已缓存向量；undefined 表示需要重新计算。
    const cached = embedCache.get(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ idx: i, text: texts[i] });
    }
  }

  // 仅在存在未命中项时发起计算，避免空批次请求。
  if (uncached.length > 0) {
    // 去除索引包装，仅提交未命中的文本内容。
    const vectors = await fn(uncached.map(u => u.text));
    // 将新向量写回原始位置，并同步更新缓存。
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i].idx] = vectors[i];
      embedCache.set(uncached[i].text, vectors[i]);
    }
  }

  return results;
}

/**
 * 使用确定性字符累加算法生成归一化模拟向量。
 *
 * 处理流程：初始化固定维度的零向量 → 将每个字符编码累加到两个确定位置 →
 * 计算向量的 L2 范数 → 做归一化并返回。
 *
 * @param text 待转换为向量的文本。
 * @returns 长度为 DIMS 且近似单位长度的浮点向量。
 */
function mockEmbed(text: string): number[] {
  // 初始化固定维度的全零向量，保证结果形状稳定。
  const vec = new Array(DIMS).fill(0);
  // 将每个字符的编码分散累加到两个位置，增加哈希结果的区分度。
  for (let i = 0; i < text.length; i++) {
    // 当前字符的 UTF-16 编码值，作为确定性贡献来源。
    const code = text.charCodeAt(i);
    vec[i % DIMS] += code;
    vec[(i * 7 + 13) % DIMS] += code * 0.3;
  }
  // 计算 L2 范数；空文本时使用 1，避免除零。
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  // L2 归一化后返回，便于与余弦相似度配合使用。
  return vec.map(v => v / norm);
}

/**
 * 计算两个向量的余弦相似度。
 *
 * 处理流程：遍历向量累加点积和两个平方范数 → 计算两个范数的乘积 →
 * 用点积除以范数乘积；当输入为零向量时使用 1 避免除零。
 *
 * @param a 第一个向量。
 * @param b 第二个向量，长度应与 a 一致。
 * @returns [-1, 1] 范围内的相似度；零向量场景返回安全的有限值。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  // 分别累计点积及两个向量的平方范数，最后组合成余弦公式。
  let dot = 0, normA = 0, normB = 0;
  // 按向量下标累加；调用方应确保两个向量长度匹配。
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/** 对外导出向量维度，供索引存储或校验逻辑复用。 */
export { DIMS };
