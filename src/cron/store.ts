import fs from 'node:fs';
import type { CronJobConfig, RunLog } from './types.js';

/**
 * 定时任务配置文件在存储目录下的相对路径。
 * 存储格式为标准 JSON，包含所有的定时任务配置列表。
 */
const JOBS_FILE = '.cron/jobs.json';

/**
 * 定时任务运行日志文件在存储目录下的相对路径。
 * 存储格式为 JSON Lines（.jsonl），每行表示一条独立的 JSON 格式执行日志，适合高频追加写入。
 */
const LOGS_FILE = '.cron/logs.jsonl';

/**
 * CronStore 定时任务存储管理类
 *
 * 【整体作用与职责】
 * 本类负责定时任务模块的数据持久化，主要管理两类数据：
 * 1. 任务配置（CronJobConfig）：保存用户或系统注册的定时任务规则（如触发周期、执行动作、状态等）。
 * 2. 运行日志（RunLog）：记录每次任务执行的历史记录（如开始时间、结束时间、执行状态、输出结果与错误信息）。
 *
 * 【具体实现机制】
 * - 目录管理：基于指定的根目录（默认当前目录 `.`），统一在 `.cron/` 目录下组织数据文件。
 * - 任务配置存储：使用标准 JSON 文件（`.cron/jobs.json`）覆盖写入，带有美化缩进（2 空格），方便人工阅读与调试。
 * - 运行日志存储：使用 JSON Lines 格式（`.cron/logs.jsonl`）流式追加（append），避免日志膨胀导致全量读写性能损耗。
 * - 容错处理：在文件不存在或 JSON 解析异常时提供降级默认值（空数组），保证系统的健壮性。
 */
export class CronStore {
  /**
   * 构造函数
   *
   * @param baseDir - 数据存储的基础根目录路径，默认为当前工作目录 `.`。
   *                  支持自定义路径，便于单元测试隔离和多实例运行。
   */
  constructor(private baseDir: string = '.') { }

  /**
   * 获取任务配置文件的完整存储路径。
   *
   * @returns 任务配置文件绝对/相对完整路径（例如 `./.cron/jobs.json`）
   */
  private get jobsPath(): string {
    return `${this.baseDir}/${JOBS_FILE}`;
  }

  /**
   * 获取运行日志文件的完整存储路径。
   *
   * @returns 运行日志文件绝对/相对完整路径（例如 `./.cron/logs.jsonl`）
   */
  private get logsPath(): string {
    return `${this.baseDir}/${LOGS_FILE}`;
  }

  /**
   * 初始化持久化存储环境。
   *
   * 【执行流程】
   * 1. 拼接存储目录路径（`<baseDir>/.cron`）。
   * 2. 检查目录是否存在，若不存在则使用递归模式创建目录，确保后续读写文件正常。
   */
  init(): void {
    const dir = `${this.baseDir}/.cron`;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 从本地文件中加载所有已保存的定时任务配置。
   *
   * 【执行流程】
   * 1. 检查 `jobs.json` 文件是否存在，若不存在直接返回空数组 `[]`。
   * 2. 读取文件文本内容并尝试解析为 JSON 对象。
   * 3. 提取其中的 `jobs` 列表字段返回；若文件损坏或解析失败，通过 try-catch 兜底返回空数组 `[]`。
   *
   * @returns 定时任务配置对象数组
   */
  loadJobs(): CronJobConfig[] {
    if (!fs.existsSync(this.jobsPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.jobsPath, 'utf-8'));
      return data.jobs || [];
    } catch {
      return [];
    }
  }

  /**
   * 将当前的所有定时任务配置持久化保存到本地文件。
   *
   * 【执行流程】
   * 1. 调用 `this.init()` 确保 `.cron` 目录存在。
   * 2. 将传入的任务数组包装为 `{ jobs }` 对象，并以 2 空格缩进格式化为 JSON 字符串。
   * 3. 同步写入 `jobs.json` 文件（覆盖写入）。
   *
   * @param jobs - 需要保存的定时任务配置列表
   */
  saveJobs(jobs: CronJobConfig[]): void {
    this.init();
    fs.writeFileSync(this.jobsPath, JSON.stringify({ jobs }, null, 2));
  }

  /**
   * 追加写入单条任务执行日志。
   *
   * 【执行流程】
   * 1. 调用 `this.init()` 确保 `.cron` 目录存在。
   * 2. 将单条 `RunLog` 日志对象序列化为单行 JSON 字符串，并在末尾添加换行符 `\n`。
   * 3. 同步追加写入 `logs.jsonl` 文件末尾。
   *
   * @param log - 单次任务执行日志对象
   */
  appendLog(log: RunLog): void {
    this.init();
    fs.appendFileSync(this.logsPath, JSON.stringify(log) + '\n');
  }

  /**
   * 获取最近的任务执行日志。
   *
   * 【执行流程】
   * 1. 检查 `logs.jsonl` 日志文件是否存在，若不存在直接返回空数组 `[]`。
   * 2. 读取整个日志文件，按换行符 `\n` 切分并过滤掉空行。
   * 3. 逐行解析 JSON 格式为 `RunLog` 对象，跳过损坏的日志行。
   * 4. 如果指定了 `jobId`，则仅筛选出属于该任务的日志记录。
   * 5. 截取最后 `limit` 条记录并返回（即时间最近的执行记录）。
   *
   * @param jobId - 可选，过滤特定任务 ID 的日志；未提供则查询所有任务的日志
   * @param limit - 返回的最大日志条数，默认为 10 条
   * @returns 过滤与截取后的执行日志数组
   */
  getRecentLogs(jobId?: string, limit = 10): RunLog[] {
    if (!fs.existsSync(this.logsPath)) return [];
    const lines = fs.readFileSync(this.logsPath, 'utf-8')
      .split('\n')
      .filter(Boolean);

    let logs: RunLog[] = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean) as RunLog[];

    if (jobId) logs = logs.filter(l => l.jobId === jobId);
    return logs.slice(-limit);
  }
}