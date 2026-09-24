import type { SubAgentConfig, SubAgentRun } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

/**
 * 子代理注册与管理中心 (SubAgentRegistry)
 *
 * 【整体作用与定位】
 * 在多智能体（Multi-Agent）或分层 Agent 系统中，主 Agent 可以将复杂任务拆解并派生（Spawn）出子 Agent 执行。
 * 本类作为子代理的生命周期与运行时管理中心，负责：
 * 1. 唯一标识生成：为每个子代理任务生成全局唯一的运行 ID。
 * 2. 调度与安全约束校验：防止子代理无限制递归嵌套（嵌套深度限制）以及无限制并发（最大并发数限制）。
 * 3. 状态与生命周期追踪：跟踪记录子代理的创建、运行、完成、失败等全生命周期状态及执行结果。
 * 4. 任务查询：提供对运行中任务及全部历史任务的查询接口。
 *
 * 【具体实现方式】
 * - 使用内存中的 Map 结构 (`runs`) 维护任务运行时数据。
 * - 结合配置对象 (`SubAgentConfig`) 中的规则进行并发与深度安全门禁检查。
 */
export class SubAgentRegistry {
  /**
   * 存储所有子代理运行记录的字典表
   * - Key: 子代理运行 ID (`id`)
   * - Value: 子代理运行状态对象 (`SubAgentRun`)
   */
  private runs = new Map<string, SubAgentRun>();

  /**
   * 子代理全局配置项（包含最大嵌套深度、最大并发数、超时时间等规则）
   */
  private config: SubAgentConfig;

  /**
   * 自增序列号计数器，用于配合时间戳生成唯一的子代理 ID
   */
  private idCounter = 0;

  /**
   * 构造函数：初始化子代理注册表配置
   *
   * @param config - 可选的自定义配置项。传入的部分配置将与默认配置 `DEFAULT_CONFIG` 浅合并
   */
  constructor(config?: Partial<SubAgentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 生成子代理任务的唯一标识 ID
   *
   * 【执行流程】
   * 1. 自增计数器 `idCounter`，保证当前实例内单调递增。
   * 2. 获取当前毫秒时间戳转换为 36 进制并截取后 4 位，增加随机性/唯一性。
   * 3. 格式化拼接为 `sub-{自增编号}-{时间戳哈希}` 的形式（例如：`sub-1-a8x9`）。
   *
   * @returns 生成的唯一子代理任务 ID
   */
  generateId(): string {
    return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`;
  }

  /**
   * 校验当前是否允许派生（Spawn）新的子代理
   *
   * 【安全校验流程】
   * 1. 嵌套深度校验：检查当前调用层级 `currentDepth` 是否已达到配置的最大允许深度 `maxSpawnDepth`。
   *    - 目的：防止 Agent 之间互相循环派生导致无限递归调用爆栈。
   * 2. 并发数量校验：统计当前状态为 `'running'` 的活跃子代理数量，检查是否达到 `maxConcurrent` 限制。
   *    - 目的：避免同时创建过多子代理消耗过多系统资源或并发请求限流。
   *
   * @param currentDepth - 派生发起方当前的嵌套深度（主 Agent 深度一般为 0，派生的子 Agent 深度为 1，依此类推）
   * @returns 返回包含 `ok`（是否允许派生）及未通过原因 `reason` 的校验结果对象
   */
  canSpawn(currentDepth: number): { ok: boolean; reason?: string } {
    if (currentDepth >= this.config.maxSpawnDepth) {
      return { ok: false, reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}` };
    }

    const activeCount = this.getActiveRuns().length;
    if (activeCount >= this.config.maxConcurrent) {
      return { ok: false, reason: `已达最大并发数 ${this.config.maxConcurrent}，等待现有任务完成` };
    }

    return { ok: true };
  }

  /**
   * 注册新创建的子代理任务记录
   *
   * 【执行流程】
   * 将构建好的 `SubAgentRun` 实例以其唯一 `id` 为键存入 `runs` 字典中，初始状态通常为 `'running'`。
   *
   * @param run - 子代理运行时状态对象
   */
  register(run: SubAgentRun): void {
    this.runs.set(run.id, run);
  }

  /**
   * 标记指定子代理任务成功完成
   *
   * 【执行流程】
   * 1. 根据 `id` 在 `runs` 中查找对应记录，若不存在则直接返回。
   * 2. 将任务状态更新为 `'completed'`。
   * 3. 记录任务执行返回的结果文本 `result`。
   * 4. 记录任务结束的时间戳 `finishedAt`（ISO 8601 格式字符串）。
   *
   * @param id - 子代理任务 ID
   * @param result - 子代理执行完成后的输出结果文本
   */
  complete(id: string, result: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'completed';
    run.result = result;
    run.finishedAt = new Date().toISOString();
  }

  /**
   * 标记指定子代理任务执行失败/发生异常
   *
   * 【执行流程】
   * 1. 根据 `id` 在 `runs` 中查找对应记录，若不存在则直接返回。
   * 2. 将任务状态更新为 `'error'`。
   * 3. 记录捕获到的异常或错误描述信息 `error`。
   * 4. 记录任务结束的时间戳 `finishedAt`（ISO 8601 格式字符串）。
   *
   * @param id - 子代理任务 ID
   * @param error - 失败时的错误信息或异常堆栈描述
   */
  fail(id: string, error: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'error';
    run.error = error;
    run.finishedAt = new Date().toISOString();
  }

  /**
   * 根据 ID 查询单个子代理任务的详细信息与运行状态
   *
   * @param id - 目标子代理任务 ID
   * @returns 子代理运行状态对象 `SubAgentRun`，若不存在则返回 `undefined`
   */
  get(id: string): SubAgentRun | undefined {
    return this.runs.get(id);
  }

  /**
   * 获取当前处于活跃运行状态（`status === 'running'`）的所有子代理任务列表
   *
   * 【执行流程】
   * 遍历 `runs` 中的所有值，筛选出状态为 `'running'` 的任务数组。
   *
   * @returns 正在运行中的子代理任务数组
   */
  getActiveRuns(): SubAgentRun[] {
    return Array.from(this.runs.values()).filter(r => r.status === 'running');
  }

  /**
   * 获取所有已注册的子代理任务列表（包含所有状态：running、completed、error、timeout 等）
   *
   * @returns 所有子代理任务数组
   */
  getAllRuns(): SubAgentRun[] {
    return Array.from(this.runs.values());
  }

  /**
   * 获取当前的子代理注册表全局配置对象
   *
   * @returns 包含并发限制、最大深度、默认超时时间等配置信息的对象
   */
  getConfig(): SubAgentConfig {
    return this.config;
  }
}
