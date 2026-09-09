import type { Chunk } from './chunker';

/** 在原始文本分块基础上附加向量及写入时间的存储结构。 */
export interface StoredChunk extends Chunk {
  /** 用于相似度检索的文本嵌入向量。 */
  embedding: number[];
  /** 分块写入向量库时的时间戳（毫秒）。 */
  addedAt: number;
}

/**
 * 基于内存数组的轻量向量存储。
 *
 * 通过分块 ID 去重并支持批量写入、全量读取、数量统计、清空和来源枚举，
 * 适合本地运行或小规模数据集；进程结束后数据不会持久化。
 */
export class VectorStore {
  /** 当前已存储的文本分块及其嵌入向量。 */
  private chunks: StoredChunk[] = [];

  /**
   * 新增或更新一个文本分块。
   *
   * 处理流程：先按分块 ID 查找已有记录 → 找到则原位替换并刷新写入时间 →
   * 未找到则追加新记录；因此重复添加同一 ID 不会产生重复数据。
   *
   * @param chunk 待存储的文本分块。
   * @param embedding 与分块文本对应的嵌入向量。
   */
  add(chunk: Chunk, embedding: number[]): void {
    // 使用 ID 定位记录，保证同一来源中的同一分块可被更新。
    const existing = this.chunks.findIndex(c => c.id === chunk.id);
    if (existing >= 0) {
      // 更新已有项时保留分块字段，并替换向量和时间戳。
      this.chunks[existing] = { ...chunk, embedding, addedAt: Date.now() };
    } else {
      // 首次出现的分块直接追加到内存存储中。
      this.chunks.push({ ...chunk, embedding, addedAt: Date.now() });
    }
  }

  /**
   * 批量新增或更新文本分块。
   *
   * 处理流程：按输入顺序遍历“分块 + 向量”配对项，并逐项复用 {@link add} 的
   * 去重/更新逻辑，确保单条写入和批量写入行为一致。
   *
   * @param items 待写入的分块与对应向量列表。
   */
  addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
    // 解构每个配对项，避免调用方需要分别维护分块和向量的索引。
    for (const { chunk, embedding } of items) {
      this.add(chunk, embedding);
    }
  }

  /**
   * 获取当前存储的全部分块。
   *
   * 处理流程：直接返回内部数组，调用方可按需遍历并执行检索计算。
   *
   * @returns 当前所有已存储分块。
   */
  getAll(): StoredChunk[] {
    return this.chunks;
  }

  /**
   * 统计当前分块数量。
   *
   * 处理流程：读取内部数组长度，不对数据做额外遍历或转换。
   *
   * @returns 存储中的分块总数。
   */
  size(): number {
    return this.chunks.length;
  }

  /**
   * 清空全部分块及其向量。
   *
   * 处理流程：用新的空数组替换现有数组，使后续查询立即返回空结果。
   */
  clear(): void {
    this.chunks = [];
  }

  /**
   * 获取当前数据涉及的去重来源列表。
   *
   * 处理流程：提取每个分块的 source → 使用 Set 去重 → 展开为普通数组返回。
   *
   * @returns 按首次出现顺序排列的来源字符串列表。
   */
  sources(): string[] {
    return [...new Set(this.chunks.map(c => c.source))];
  }
}
