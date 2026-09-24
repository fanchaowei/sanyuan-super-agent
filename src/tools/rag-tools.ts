/**
 * 使用 SQLite + sqlite-vec + FTS5 处理的版本
 */

import fs from 'node:fs';
import { chunkDocument } from '../rag/chunker';
import { embed, type EmbeddingFn } from '../rag/embedder';
// import { hybridSearch } from '../rag/search';
// import { VectorStore } from '../rag/store';
import { SqliteVectorStore } from '../rag/sqlite-store';
import type { ToolDefinition } from './tool-registry';

/**
 * 创建并返回一组用于 RAG（检索增强生成）的工具定义列表。
 *
 * 包含两个核心工具：
 * 1. `rag_ingest`: 文档导入工具，负责读取文档、文本分块、向量化并批量存入向量数据库。
 * 2. `rag_search`: 知识库混合检索工具，结合语义向量余弦相似度与关键词匹配进行 Top-K 检索。
 *
 * @param vectorStore - 向量存储实例，用于管理分块数据及其高维向量
 * @param embedFn - 文本向量化函数，用于将文本转换为向量
 * @returns 包含 `rag_ingest` 和 `rag_search` 的工具定义数组
 */
export function createRagTools(vectorStore: SqliteVectorStore, embedFn: EmbeddingFn): ToolDefinition[] {
  /**
   * 文档导入工具定义。
   *
   * 执行关键过程：
   * 1. 接收文件路径并读取文件纯文本内容。
   * 2. 调用 chunkDocument 将文本按段落/标题/行进行分块并添加元数据（来源、索引、字符范围等）。
   * 3. 提取所有分块文本，调用 embed 批量生成高维特征向量。
   * 4. 组合分块与向量，调用 vectorStore.addBatch 批量写入向量库。
   * 5. 返回导入分块数量及当前知识库总片段数等统计信息；发生异常时捕获并返回错误信息。
   */
  const ragIngestTool: ToolDefinition = {
    name: 'rag_ingest',
    description: '将文档导入知识库。path 为文件路径，内容会被分块、向量化后存储。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文档路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ path }: { path: string }) => {
      try {
        // 1. 读取指定路径的文本文件内容
        const text = fs.readFileSync(path, 'utf-8');

        // 2. 对文档文本进行分块处理，生成包含元数据的 Chunk 数组
        const chunks = chunkDocument(path, text);

        // 3. 批量将分块文本转化为嵌入向量
        const embeddings = await embed(embedFn, chunks.map(c => c.text));

        // 4. 将分块及其对应的向量配对，批量存入向量数据库
        vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));

        // 5. 组装并返回导入成功的统计提示信息
        return `已导入 ${chunks.length} 个文档片段（来源: ${path}）。知识库共 ${vectorStore.size()} 个片段。`;
      } catch (e: any) {
        // 捕获文件读取、分块或向量化过程中的异常并返回失败原因
        return `导入失败: ${e.message}`;
      }
    },
  };

  /**
   * 知识库搜索工具定义。
   *
   * 执行关键过程：
   * 1. 检查知识库状态，若为空则拦截并提示用户先导入文档。
   * 2. 调用 hybridSearch 混合检索算法（结合向量余弦相似度与关键词评分，并通过 MMR 重排序去重）。
   * 3. 若无匹配结果，返回未找到提示。
   * 4. 格式化检索结果列表，展示序号、来源、综合得分、向量/关键词分项得分以及分块文本内容预览。
   */
  const ragSearchTool: ToolDefinition = {
    name: 'rag_search',
    description: '从知识库中搜索相关信息。返回最相关的文档片段。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        top_k: { type: 'number', description: '返回结果数量（默认 5）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query, top_k }: { query: string; top_k?: number }) => {
      // 1. 快速检查：向量库为空时直接拦截并提示
      if (vectorStore.size() === 0) return '知识库为空，请先使用 rag_ingest 导入文档。';

      // 2. 执行向量与关键词融合的混合检索（默认返回 Top 5）
      const results = await vectorStore.hybridSearch(embedFn, query, top_k || 5);


      // 3. 结果为空时的友好提示
      if (results.length === 0) return `没有找到与 "${query}" 相关的内容。`;

      // 4. 遍历检索结果并格式化为易读的多段文本（包含来源、综合分、分项分及文本片段预览）
      return results.map((r, i) =>
        `[${i + 1}] 来源: ${r.chunk.source} | 综合分: ${r.score.toFixed(3)} (向量: ${r.vectorScore.toFixed(2)}, 关键词: ${r.keywordScore.toFixed(2)})\n${r.chunk.text.slice(0, 500)}`
      ).join('\n\n---\n\n');
    },
  };

  // 返回包含导入和搜索工具的列表
  return [ragIngestTool, ragSearchTool];
}
