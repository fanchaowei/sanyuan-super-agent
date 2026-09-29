import { getNextCronTime, parseSchedule } from './parser.js';
import { CronStore } from './store.js';
import type { CronJobConfig, CronJobState, JobPayload, RunLog } from './types.js';

/**
 * 内置示例名言数组。
 * 用于内置 handler 任务（"random-quote"）执行时随机抽取一条名言输出，供学习与测试使用。
 */
const QUOTES: string[] = [
  '"知之为知之，不知为不知，是知也。" —— 孔子',
  '"学而不思则罔，思而不学则殆。" —— 孔子',
  '"千里之行，始于足下。" —— 老子',
  '"天行健，君子以自强不息。" —— 《周易》',
  '"不积跬步，无以至千里。" —— 荀子',
  '"Stay hungry, stay foolish." —— Steve Jobs',
  '"The best way to predict the future is to invent it." —— Alan Kay',
  '"Talk is cheap. Show me the code." —— Linus Torvalds',
  '"Simplicity is the ultimate sophistication." —— Leonardo da Vinci',
  '"First, solve the problem. Then, write the code." —— John Johnson',
];

export interface CronServiceOptions {
  baseDir?: string;
  maxJobs?: number;         // 最大任务数上限，默认 50
  minIntervalMs?: number;   // 最小调度间隔（用于下一项拓展）
  maxConcurrency?: number;  // 最大并发执行数（用于第四项拓展）
}

/**
 * CronExecutor 外部执行器接口
 *
 * 【设计目的】
 * 实现了定时任务调度核心逻辑与外部 Agent 运行时以及消息通知机制的解耦。
 * CronService 仅负责“何时触发”与“状态维护”，具体的“如何执行 Agent Prompt”和“如何发送通知”由调用方注入。
 */
export interface CronExecutor {
  /**
   * 执行 Agent Prompt 的回调函数，支持传入 abortSignal 实现主动中断
   *
   * @param prompt - 提示词内容
   * @param timeout - 超时毫秒数
   * @param signal - 用于接收取消信号的 AbortSignal 对象
   */
  runAgentPrompt: (prompt: string, timeout?: number, signal?: AbortSignal) => Promise<string>;

  /**
   * 任务执行完成或失败时的通知推送回调函数（可选）。
   *
   * @param message - 通知文本消息（例如输出到终端 UI、系统通知或聊天渠道）
   */
  notify?: (message: string) => void;
}

/**
 * CronService 定时任务调度管理服务类
 *
 * 【整体作用与职责】
 * 本类是定时任务模块的中枢控制类，主要负责：
 * 1. 任务生命周期管理：支持任务的新增、删除、启用、禁用、列表查询与立即手动触发。
 * 2. 动态调度引擎：解析 cron 表达式、固定时间间隔（interval）及一次性时间戳（once），基于 setTimeout 实现精准延时调度与递归循环触发。
 * 3. 容错与熔断机制：防止单任务重入并发执行；监控任务连续失败次数，达到阈值时自动禁用（熔断），防止持续报错消耗系统资源。
 * 4. 运行日志与通知闭环：完整记录每次执行的开始/结束时间、状态、输出和错误，并持久化到文件，同时支持向外推送执行通知。
 * 5. 数据持久化同步：将运行时动态添加的任务与静态配置任务合并持久化保存。
 */
export class CronService {
  /**
   * 内存中所有已加载任务的运行时状态映射表。
   * Key: 任务唯一标识 id (string)
   * Value: 任务运行时状态对象 CronJobState（包含配置、定时器句柄、执行中标志等）
   */
  private jobs: Map<string, CronJobState> = new Map<string, CronJobState>();

  /**
   * 持久化存储实例，负责任务配置及运行日志的本地文件读写。
   */
  private store: CronStore;

  /**
   * 外部注入的任务执行器（包含 runAgentPrompt 和 notify）。
   */
  private executor?: CronExecutor;

  /**
   * 标识当前定时服务是否处于启动（运行）状态。
   * true: 服务已启动，会正常注册定时器并等待触发
   * false: 服务已停止，所有定时器均被清除
   */
  private running: boolean = false;

  private maxJobs: number;

  private maxConcurrency: number = 3;  // 最大允许同时执行的任务数量
  private activeRuns: number = 0;      // 当前正在执行的任务计数器
  private executionQueue: Array<() => Promise<void>> = []; // 待执行任务队列

  /**
   * 构造函数
   *
   * @param baseDir - 数据持久化存储的根目录路径，默认为当前目录 `.`
   */
  constructor(options: CronServiceOptions) {

    const baseDir = options.baseDir ?? '.'

    // 最大任务数 50 条
    this.maxJobs = options.maxJobs ? Math.min(options.maxJobs, 50) : 50

    this.store = new CronStore(baseDir);
    this.store.init();
  }

  /**
   * 设置（注入）外部执行器。
   *
   * @param executor - 实现了 CronExecutor 接口的执行器对象
   */
  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  /**
   * 从本地持久化存储加载任务配置到内存中。
   *
   * 【执行流程】
   * 1. 调用 `store.loadJobs()` 读取本地所有已保存的任务配置。
   * 2. 遍历配置，将所有处于启用状态（`enabled === true`）的任务构造成初始 `CronJobState` 存入内存 `this.jobs` Map。
   */
  load(): void {
    const configs = this.store.loadJobs();
    for (const config of configs) {
      if (config.enabled) {
        this.jobs.set(config.id, {
          config,
          timerId: null,
          consecutiveFailures: 0,
          running: false,
        });
      }
    }
  }

  /**
   * 启动定时任务调度引擎。
   *
   * 【执行流程】
   * 1. 检查是否已经处于运行状态，防止重复启动。
   * 2. 标记 `this.running = true`。
   * 3. 遍历内存中所有任务，对启用的任务调用 `scheduleJob` 计算下一次执行时间并启动定时器。
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const state of this.jobs.values()) {
      if (state.config.enabled) {
        this.scheduleJob(state);
      }
    }
  }

  /**
   * 停止定时任务调度引擎。
   *
   * 【执行流程】
   * 1. 标记 `this.running = false`。
   * 2. 遍历内存中所有任务，清除（clearTimeout）当前挂起等待触发的定时器句柄，并将 `timerId` 置空。
   */
  stop(): void {
    this.running = false;
    for (const state of this.jobs.values()) {
      if (state.timerId) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
    }
  }

  /**
   * 动态添加一个新的定时任务。
   *
   * 【执行流程】
   * 1. 校验任务 ID 是否已存在，防止重复冲突。
   * 2. 创建初始的 `CronJobState` 状态对象并存入 `this.jobs` Map。
   * 3. 调用 `persist()` 将新任务持久化到本地文件。
   * 4. 如果当前调度服务处于运行状态且该任务已启用，立即为其注册定时器调度（`scheduleJob`）。
   *
   * @param config - 新增的定时任务配置对象
   * @throws 当任务 ID 已存在时抛出错误
   */
  add(config: CronJobConfig): void {
    if (this.jobs.has(config.id)) {
      throw new Error(`任务 ${config.id} 已存在`);
    }

    if (this.jobs.size >= this.maxJobs) {
      throw new Error(`任务数量已达到上限 (${this.maxJobs} 个)，请先清理不需要的任务`);
    }

    const state: CronJobState = {
      config,
      timerId: null,
      consecutiveFailures: 0,
      running: false,
    };
    this.jobs.set(config.id, state);
    this.persist();
    if (this.running && config.enabled) {
      this.scheduleJob(state);
    }
  }

  /**
   * 根据任务 ID 删除一个定时任务。
   *
   * 【执行流程】
   * 1. 检查内存中是否存在该任务，不存在则直接返回 false。
   * 2. 清除该任务当前挂起的定时器（如果有）。
   * 3. 从 `this.jobs` Map 中移除该任务。
   * 4. 同步更新本地持久化文件。
   *
   * @param id - 需要删除的任务唯一标识 ID
   * @returns 删除成功返回 true，任务不存在返回 false
   */
  remove(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    if (state.timerId) {
      clearTimeout(state.timerId);
    }
    this.jobs.delete(id);
    this.persist();
    return true;
  }

  /**
   * 启用指定的定时任务。
   *
   * 【执行流程】
   * 1. 查找目标任务，不存在则返回 false。
   * 2. 将 `config.enabled` 标记为 true，并重置连续失败计数器 `consecutiveFailures = 0`。
   * 3. 同步更新持久化文件。
   * 4. 如果调度服务当前正在运行，立即调用 `scheduleJob` 开始倒计时调度。
   *
   * @param id - 目标任务 ID
   * @returns 启用成功返回 true，任务不存在返回 false
   */
  enable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = true;
    state.consecutiveFailures = 0;
    this.persist();
    if (this.running) {
      this.scheduleJob(state);
    }
    return true;
  }

  /**
   * 禁用指定的定时任务。
   *
   * 【执行流程】
   * 1. 查找目标任务，不存在则返回 false。
   * 2. 将 `config.enabled` 标记为 false。
   * 3. 取消当前已注册的定时器句柄并置空。
   * 4. 同步更新持久化文件。
   *
   * @param id - 目标任务 ID
   * @returns 禁用成功返回 true，任务不存在返回 false
   */
  disable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = false;
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    this.persist();
    return true;
  }

  /**
   * 获取当前所有任务的状态列表视图。
   *
   * 【状态映射规则】
   * - 'running'：当前任务正在异步执行中
   * - 'disabled'：任务已被禁用
   * - 'scheduled'：任务已启用且定时器已就绪等待触发
   * - 'idle'：任务已启用但未调度（例如服务处于 stop 状态）
   *
   * @returns 包含任务配置、状态描述及最近一次执行日志的对象数组
   */
  list(): Array<{ config: CronJobConfig; status: string; lastRun?: RunLog }> {
    return Array.from(this.jobs.values()).map(state => ({
      config: state.config,
      status: state.running
        ? 'running'
        : !state.config.enabled
          ? 'disabled'
          : state.timerId
            ? 'scheduled'
            : 'idle',
      lastRun: state.lastRun,
    }));
  }

  /**
   * 带并发限制的任务执行入口
   *
   * 【调度逻辑】
   * 1. 若当前活跃任务数未达上限，立即启动执行。
   * 2. 若当前已达并发上限，将执行逻辑排入队列等待空闲。
   */
  private runWithConcurrency(fn: () => Promise<void>): void {
    if (this.activeRuns < this.maxConcurrency) {
      this.activeRuns++;
      fn().finally(() => {
        this.activeRuns--;
        this.nextInQueue(); // 任务完成，尝试唤醒队列中的下一个任务
      });
    } else {
      console.log(`  [cron] 并发已满 (${this.activeRuns}/${this.maxConcurrency})，任务已加入排队队列`);
      this.executionQueue.push(fn);
    }
  }

  /**
   * 唤醒队列中下一个排队的任务
   */
  private nextInQueue(): void {
    if (this.executionQueue.length > 0 && this.activeRuns < this.maxConcurrency) {
      const nextTask = this.executionQueue.shift();
      if (nextTask) {
        this.activeRuns++;
        nextTask().finally(() => {
          this.activeRuns--;
          this.nextInQueue();
        });
      }
    }
  }

  /**
   * 立即手动触发执行指定的定时任务（忽略原本的调度时间）。
   *
   * @param id - 目标任务 ID
   * @returns 任务执行的输出结果字符串，或不存在时的提示信息
   */
  async runNow(id: string): Promise<string> {
    const state = this.jobs.get(id);
    if (!state) return `任务 ${id} 不存在`;
    return this.executeJob(state);
  }

  /**
   * 获取任务历史执行日志。
   *
   * @param jobId - 可选，过滤特定任务 ID 的日志；不传则返回所有任务的日志
   * @param limit - 返回的最大日志条数，默认为 10
   * @returns 匹配的执行日志列表
   */
  getRecentLogs(jobId?: string, limit?: number): RunLog[] {
    return this.store.getRecentLogs(jobId, limit);
  }

  /**
   * 计算并注册单个任务的下一次定时执行。
   *
   * 【执行流程】
   * 1. 若当前已有挂起的定时器，先清除避免重复触发。
   * 2. 解析调度表达式（`parseSchedule`），根据类型计算等待毫秒数 `delayMs`：
   *    - interval（固定间隔）：直接获取毫秒数（如 every 30s -> 30000ms）。
   *    - once（一次性任务）：目标绝对时间减去当前时间，若已过期则立即执行。
   *    - cron（Cron 表达式）：使用 croner 计算距离下一次满足条件的时间差（毫秒）。
   * 3. 通过 `setTimeout` 注册延时触发回调：
   *    - 倒计时结束时，异步调用 `executeJob` 执行任务逻辑。
   *    - 循环任务（cron / interval）：若任务仍启用且服务在运行中，递归调用 `scheduleJob` 进入下一轮调度。
   *    - 一次性任务（once）：执行完成后自动从任务列表中移除。
   *
   * @param state - 任务的内存运行时状态
   */
  private scheduleJob(state: CronJobState): void {
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    try {
      const parsed = parseSchedule(state.config.schedule);
      let delayMs: number;
      switch (parsed.type) {
        case 'interval':
          delayMs = parsed.intervalMs!;
          break;
        case 'once': {
          const diff = parsed.onceAt!.getTime() - Date.now();
          if (diff <= 0) {
            this.executeJob(state);
            return;
          }
          delayMs = diff;
          break;
        }
        case 'cron':
          delayMs = getNextCronTime(parsed.cronInstance!);
          break;
      }
      state.timerId = setTimeout(async () => {
        // 将任务包装并投递进并发控制器
        this.runWithConcurrency(async () => {
          await this.executeJob(state);
          if (parsed.type !== 'once' && state.config.enabled && this.running) {
            this.scheduleJob(state);
          } else if (parsed.type === 'once') {
            this.remove(state.config.id);
          }
        });
      }, delayMs);
    } catch (err: any) {
      console.log(`  [cron] ✗ 调度失败 ${state.config.id}: ${err.message}`);
    }
  }

  /**
   * 执行单个任务的核心流程。
   *
   * 【执行流程】
   * 1. 并发防重入检查：若该任务当前正在执行中（`state.running === true`），则跳过本次执行。
   * 2. 状态锁定：置 `state.running = true`，并记录开始时间 `startedAt`。
   * 3. 业务派发与执行：调用 `runPayload` 执行 Agent Prompt 或 handler，支持配置的超时控制。
   * 4. 异常处理与自动熔断：
   *    - 捕获异常并识别是否为超时错误（status 设为 timeout 或 error）。
   *    - 累加连续失败次数 `consecutiveFailures`。
   *    - 若连续失败次数达到阈值（`maxRetries`，默认 3 次），则自动将任务禁用（熔断），防止持续错误。
   * 5. 状态释放与日志记录：
   *    - 在 finally 块中释放执行锁（`state.running = false`）。
   *    - 组装 `RunLog` 对象，更新 `state.lastRun` 并持久化写入 `CronStore`。
   *    - 若配置了 `executor.notify`，则发送结果通知。
   *
   * @param state - 目标任务的运行时状态
   * @returns 任务执行的输出内容
   */
  private async executeJob(state: CronJobState): Promise<string> {
    if (state.running) return '任务正在执行中';
    state.running = true;
    const startedAt = new Date().toISOString();
    let output = '';
    let status: RunLog['status'] = 'success';
    let error: string | undefined;

    // 1. 创建 AbortController 实例，用于向下传递取消信号
    const controller = new AbortController();
    const timeoutMs = state.config.timeout || 60000;

    // 2. 启动超时定时器：到达超时时间后主动调用 abort()
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`任务执行超时（超过 ${timeoutMs}ms）`));
    }, timeoutMs);

    try {
      output = await this.runPayload(state.config.payload, timeoutMs, controller.signal);
      // 执行成功，重置连续失败计数
      state.consecutiveFailures = 0;
    } catch (err: any) {
      // 判断是否是由 AbortController 触发的超时或中断
      const isAborted = controller.signal.aborted || err.name === 'AbortError';

      status = isAborted || err.message?.includes('超时') || err.message?.includes('timeout')
        ? 'timeout'
        : 'error';

      error = err.message;
      output = `执行失败: ${err.message}`;
      state.consecutiveFailures++;
      const maxRetries = state.config.maxRetries ?? 3;
      // 连续失败达到阈值，触发自动熔断禁用
      if (state.consecutiveFailures >= maxRetries) {
        state.config.enabled = false;
        console.log(`  [cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`);
        this.persist();
      }
    } finally {
      // 4. 执行完毕无论成功失败，务必清除超时定时器，防止内存泄漏
      clearTimeout(timeoutId);
      state.running = false;
    }

    // 组装并保存运行日志
    const log: RunLog = {
      jobId: state.config.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      output: output.slice(0, 1000), // 截断避免日志过大
      error,
    };
    state.lastRun = log;
    this.store.appendLog(log);

    // 触发外部通知推送
    if (this.executor?.notify) {
      const icon = status === 'success' ? '✓' : '✗';
      this.executor.notify(`[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`);
    }

    return output;
  }

  /**
   * 根据 payload 类型分发并执行具体的任务载荷。
   *
   * 【支持的 Payload 类型】
   * 1. 'agent': 交付给 Agent Loop 执行自然语言 Prompt，支持超时限制。
   * 2. 'handler': 调用内置或插件注册的具名处理函数（如内置的 "random-quote" 名言生成）。
   *
   * @param payload - 任务载荷配置（Agent Prompt 或 Handler 名称）
   * @param timeout - 超时时间（毫秒）
   * @returns 具体的执行返回字符串
   */
  private async runPayload(payload: JobPayload, timeout: number, signal?: AbortSignal): Promise<string> {
    if (!this.executor) return '[cron] 未设置执行器，无法运行任务';
    if (payload.type === 'agent') {
      return this.executor.runAgentPrompt(payload.prompt, timeout, signal);
    }
    if (payload.type === 'handler') {
      if (payload.handler === 'random-quote') {
        return QUOTES[Math.floor(Math.random() * QUOTES.length)];
      }
      return `[handler] ${payload.handler} — handler 类型需要通过插件注册`;
    }
    return '未知 payload 类型';
  }

  /**
   * 持久化保存所有运行时创建的动态任务。
   *
   * 【持久化原则】
   * - 只保存 `source === 'runtime'` 的动态任务配置。
   * - 从持久化存储中保留原有的 `source === 'config'` 静态任务，合并后重新写入文件，避免覆盖硬编码配置。
   */
  private persist(): void {
    const configs = Array.from(this.jobs.values())
      .filter(s => s.config.source === 'runtime')
      .map(s => s.config);
    const existing = this.store.loadJobs().filter(j => j.source === 'config');
    this.store.saveJobs([...existing, ...configs]);
  }


}