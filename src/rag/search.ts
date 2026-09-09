import type { EmbeddingFn } from './embedder.js';
import { cosineSimilarity, embed } from './embedder.js';
import type { StoredChunk, VectorStore } from './store.js';

export interface SearchResult {
  /** 命中的原始文本分块及其嵌入信息。 */
  chunk: StoredChunk;
  /** 融合向量分数和关键词分数后的最终排序分数。 */
  score: number;
  /** 归一化后的向量检索分数。 */
  vectorScore: number;
  /** 归一化后的关键词检索分数。 */
  keywordScore: number;
}

/** 向量检索结果在融合分数中的权重。 */
const VECTOR_WEIGHT = 0.7;
/** 关键词检索结果在融合分数中的权重。 */
const KEYWORD_WEIGHT = 0.3;
/** 两路检索各自保留的候选数量相对 topK 的放大倍数。 */
const CANDIDATE_MULTIPLIER = 4;
/** MMR 中相关性项的权重，越大越偏向高分结果。 */
const MMR_LAMBDA = 0.7;

/**
 * 执行向量与关键词融合的混合检索。
 *
 * 处理流程：
 * 1. 读取全部分块，并在存储为空时立即返回空结果。
 * 2. 用查询向量计算余弦相似度，得到第一路候选。
 * 3. 用 BM25-like 关键词评分得到第二路候选。
 * 4. 分别归一化两路分数，按权重合并同一分块的结果。
 * 5. 按融合分数排序，并通过 MMR 兼顾相关性与结果多样性。
 *
 * @param store 提供待检索分块的向量存储。
 * @param embedFn 用于生成查询向量的嵌入函数。
 * @param query 用户输入的检索文本。
 * @param topK 最终返回的结果数量，默认返回 5 条。
 * @returns 按综合相关性排序的检索结果。
 */
export async function hybridSearch(
  store: VectorStore,
  embedFn: EmbeddingFn,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  // 先读取一次快照，确保两路检索使用相同的数据集合。
  const all = store.getAll();
  // 没有可检索内容时无需调用嵌入服务或执行评分。
  if (all.length === 0) return [];

  // 两路检索先扩大候选池，再由最终排序和 MMR 筛选 topK。
  const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length);

  // 第一路：向量检索，衡量查询语义与分块向量的余弦相似度。
  const [queryVec] = await embed(embedFn, [query]);
  const vectorResults = all
    .map(chunk => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // 第二路：关键词检索，使用 BM25-like TF-IDF 分数补充精确词面匹配。
  const queryTerms = tokenize(query);
  // 文档总数用于 BM25 的逆文档频率计算。
  const docCount = all.length;
  const keywordResults = all
    .map(chunk => ({ chunk, score: bm25Score(queryTerms, chunk.text, docCount, all) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // 将不同量纲的两路分数都转换到 [0, 1]，以便进行加权融合。
  const vecNorm = normalizeMinMax(vectorResults.map(r => r.score));
  const kwNorm = normalizeViaSigmoid(keywordResults.map(r => r.score));

  // 使用分块 ID 合并候选，避免同一分块在两路结果中重复出现。
  const candidates = new Map<string, SearchResult>();

  for (let i = 0; i < vectorResults.length; i++) {
    // 以向量检索结果为基础记录，关键词分数稍后再补充。
    const id = vectorResults[i].chunk.id;
    candidates.set(id, {
      chunk: vectorResults[i].chunk,
      score: vecNorm[i] * VECTOR_WEIGHT,
      vectorScore: vecNorm[i],
      keywordScore: 0,
    });
  }

  for (let i = 0; i < keywordResults.length; i++) {
    // 关键词结果若已存在，则叠加权重；否则创建仅由关键词命中的候选。
    const id = keywordResults[i].chunk.id;
    const existing = candidates.get(id);
    if (existing) {
      existing.keywordScore = kwNorm[i];
      existing.score += kwNorm[i] * KEYWORD_WEIGHT;
    } else {
      candidates.set(id, {
        chunk: keywordResults[i].chunk,
        score: kwNorm[i] * KEYWORD_WEIGHT,
        vectorScore: 0,
        keywordScore: kwNorm[i],
      });
    }
  }

  // 先按融合分数降序排列，为 MMR 提供相关性优先的初始候选序列。
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

  // 通过 MMR 逐个选择结果，在相关性和文本重复度之间取得平衡。
  return mmrSelect(sorted, topK);
}

// ── BM25 关键词评分 ───────────────────────

/** 将文本标准化为可用于关键词匹配的词元列表。 */
function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * 计算单个文档相对于查询词的 BM25-like 分数。
 *
 * 处理流程：分词并统计文档长度 → 逐个查询词计算词频和文档频率 →
 * 结合 IDF、词频饱和度和文档长度归一化项累加得分。
 */
function bm25Score(queryTerms: string[], docText: string, N: number, allDocs: StoredChunk[]): number {
  // k1 控制词频饱和速度，b 控制文档长度归一化程度。
  const k1 = 1.2;
  const b = 0.75;
  // 当前文档的词元及所有文档的平均词元长度。
  const docTokens = tokenize(docText);
  const avgDl = allDocs.reduce((s, d) => s + tokenize(d.text).length, 0) / (N || 1);
  // 当前文档长度和最终累计分数。
  const dl = docTokens.length;
  let score = 0;

  // 每个查询词独立计算贡献，再累加为文档总分。
  for (const term of queryTerms) {
    // 当前词在文档中的出现次数。
    const tf = docTokens.filter(t => t === term).length;
    // 包含当前词的文档数，用于衡量该词的区分度。
    const df = allDocs.filter(d => tokenize(d.text).includes(term)).length;
    // 逆文档频率：越少见的词，贡献越大。
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    // 对词频进行饱和处理，并按文档长度校正。
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)));
    score += idf * tfNorm;
  }

  return score;
}

// ── 分数归一化 ─────────────────────────────

/** 使用 Min-Max 将一组分数线性归一化到 [0, 1]。 */
function normalizeMinMax(scores: number[]): number[] {
  // 空输入直接返回空数组，避免 Math.min/Math.max 无意义计算。
  if (scores.length === 0) return [];
  // 计算区间边界；区间为零时使用 1 防止除零。
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map(s => (s - min) / range);
}

/** 使用 Sigmoid 将任意 BM25 分数平滑压缩到 (0, 1)。 */
function normalizeViaSigmoid(scores: number[]): number[] {
  return scores.map(s => 1 / (1 + Math.exp(-s)));
}

// ── MMR 多样性筛选 ─────────────────────────

/**
 * 使用最大边际相关性（MMR）从候选中选择最终结果。
 *
 * 处理流程：先保留最高融合分数的结果 → 每轮计算剩余候选的相关性与重复惩罚 →
 * 选择 MMR 分数最高者 → 直到达到 topK 或候选耗尽。
 */
function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
  // 候选数不超过目标数时无需额外筛选。
  if (results.length <= topK) return results;

  // 最高分结果作为种子，后续候选会与已选结果比较相似度。
  const selected: SearchResult[] = [results[0]];
  // 剩余候选会在每轮选择后移除，避免重复选取。
  const remaining = results.slice(1);

  // 持续选择兼顾相关性和多样性的候选，直到满足数量要求。
  while (selected.length < topK && remaining.length > 0) {
    // 记录当前轮次 MMR 最优候选的位置和分数。
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      // 候选自身的融合分数代表相关性。
      const relevance = remaining[i].score;
      // 与已选结果中最相似的文本相似度作为重复惩罚。
      const maxSim = Math.max(...selected.map(s => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)));
      // 相关性加分与重复度扣分按 lambda 加权组合。
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * 计算两段文本的 Jaccard 词元相似度，用于估计内容重复程度。
 *
 * 处理流程：分别构造两段文本的词元集合 → 求交集和并集 →
 * 以交集大小除以并集大小；两者均为空时返回 0。
 */
function jaccardSimilarity(a: string, b: string): number {
  // 集合天然去重，使相似度关注词元是否出现而非出现次数。
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  // 统计两集合交集和并集的大小。
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
