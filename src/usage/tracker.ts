import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 这个模块负责三件事：
 * 1. 把不同模型供应商返回的 usage 统一成 StepUsage；
 * 2. 按模型单价计算一次调用的费用；
 * 3. 在内存中累计每一步的用量，并可选地写入 JSONL 日志。
 *
 * 推荐的调用顺序：provider usage -> normalizeUsage -> UsageTracker.record -> totals。
 */

/**
 * 各家模型的 prompt cache 计费规则（单位：$ / 1M tokens，2026-05 数据）。
 *
 * 命中折扣不是行业默认 10x，每家差异不小：
 * - Claude：cache read = 10% input；write 5min = 125%、1h = 200%
 * - OpenAI：自动缓存，命中折扣按模型分档（4o 系列 50%，GPT-5 / 4.1 系列 25%）
 * - Gemini：cache read = 10% input（explicit 模式按存储时长另收费，这里没列）
 * - DeepSeek：cache hit = 10% miss，没有写入费、没有 TTL 概念
 * - Qwen：implicit 20%、explicit 10%（字段跟 Anthropic 一样是 `cache_control: ephemeral`）
 * - Kimi：自动模式 25%
 * - Doubao：显式 cache，命中价 = 40% miss
 *
 * 加新模型直接扩这张表就行。
 */
export interface ModelPricing {
  input: number;       // $ / 1M input tokens (cache miss)
  output: number;      // $ / 1M output tokens
  cacheWrite: number;  // $ / 1M tokens written to cache
  cacheRead: number;   // $ / 1M tokens read from cache (hit)
}

// 用模型名做 key，调用方无需知道供应商，只要传入实际使用的 model id 即可查价。
export const PRICE_TABLE: Record<string, ModelPricing> = {
  // Anthropic（最新主力，2026 上半年发布的 4.7 系列）
  'claude-opus-4-7': { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-7': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, cacheWrite: 1.25, cacheRead: 0.10 },
  // OpenAI（GPT-5 系列；GPT-5.5 默认 24h extended cache）
  'gpt-5-5': { input: 5.00, output: 20.00, cacheWrite: 5.00, cacheRead: 0.50 },
  'gpt-5': { input: 5.00, output: 15.00, cacheWrite: 5.00, cacheRead: 1.25 },
  // Google（Gemini 3 系列，最新 preview）
  'gemini-3-pro': { input: 2.50, output: 12.00, cacheWrite: 2.50, cacheRead: 0.625 },
  'gemini-3-flash': { input: 0.30, output: 1.20, cacheWrite: 0.30, cacheRead: 0.075 },
  // 国产
  'deepseek-v3-2': { input: 0.27, output: 1.10, cacheWrite: 0.27, cacheRead: 0.027 },
  'qwen3-6-plus': { input: 0.40, output: 1.20, cacheWrite: 0.40, cacheRead: 0.04 },
  'kimi-k2-6': { input: 0.60, output: 2.50, cacheWrite: 0.60, cacheRead: 0.15 },
  'doubao-2-0-pro': { input: 0.30, output: 0.90, cacheWrite: 0.30, cacheRead: 0.12 },
  // 课程内 mock，用 Haiku 4.5 同档价格
  'mock-model': { input: 1.00, output: 5.00, cacheWrite: 1.25, cacheRead: 0.10 },
};

/** 一次模型调用中，按计费方式拆分后的 token 数量。 */
export interface StepUsage {
  inputTokens: number;      // 未命中缓存、按普通输入价计费的 token
  outputTokens: number;     // 模型生成的 token
  cacheReadTokens: number;  // 从 prompt cache 读取、按命中价计费的 token
  cacheWriteTokens: number; // 新写入 prompt cache、按写入价计费的 token
}

/** StepUsage 加上追踪器生成的调用元数据，构成一条完整日志记录。 */
export interface StepRecord extends StepUsage {
  ts: number;     // Unix 时间戳（毫秒）
  model: string;  // 本次调用使用的模型名，也是 PRICE_TABLE 的查找键
  cost: number;   // 本次调用的估算费用，单位为美元
}

export class UsageTracker {
  // 当前进程内的调用记录；没有从历史日志反向加载，所以重启后会重新累计。
  private steps: StepRecord[] = [];
  // 不传路径时只做内存统计；传入路径时，每次 record 都会同步追加一行日志。
  private logPath?: string;

  constructor(logPath?: string) {
    this.logPath = logPath;
    // recursive 使多层目录不存在时也能一次创建完成。
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  /** 记录一次模型调用，并返回补全了时间、模型和费用的记录。 */
  record(model: string, usage: StepUsage): StepRecord {
    const cost = computeCost(model, usage);
    const record: StepRecord = { ts: Date.now(), model, cost, ...usage };
    this.steps.push(record);

    if (this.logPath) {
      // JSONL 是“一行一个 JSON 对象”；追加写入便于流式记录，也无需重写整个文件。
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    }
    return record;
  }

  /** 汇总当前进程记录的所有调用，并估算缓存带来的节省。 */
  totals() {
    // reduce 把每条 StepRecord 的四类 token 和实际费用分别累加。
    const t = this.steps.reduce(
      (a, s) => ({
        inputTokens: a.inputTokens + s.inputTokens,
        outputTokens: a.outputTokens + s.outputTokens,
        cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
        cost: a.cost + s.cost,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    );

    // input-like 表示所有进入上下文的 token，不论它最终按 miss、read 还是 write 计费。
    const totalInputLike = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0;

    // 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付
    const baselineCost = (() => {
      let c = 0;
      for (const s of this.steps) {
        // 未收录的模型回退到 mock-model，保证统计流程不会因缺少价格而中断。
        const p = PRICE_TABLE[s.model] || PRICE_TABLE['mock-model'];
        const inputLike = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
        c += (inputLike * p.input) / 1_000_000;
        c += (s.outputTokens * p.output) / 1_000_000;
      }
      return c;
    })();

    // savedCost 可能为负数：某些场景的 cache write 溢价可能暂时高于命中节省。
    return { ...t, hitRate, baselineCost, savedCost: baselineCost - t.cost, steps: this.steps.length };
  }

  /** 返回最后 n 条记录；slice(-n) 不会修改原数组。 */
  recent(n: number): StepRecord[] {
    return this.steps.slice(-n);
  }
}

/**
 * 根据四类 token 的独立单价计算一次调用费用。
 * 价格表单位是“美元 / 1M tokens”，所以加权求和后要除以 1_000_000。
 */
export function computeCost(model: string, usage: StepUsage): number {
  // 回退价格适合开发和演示；生产环境若要求精确计费，应确保模型已录入价格表。
  const p = PRICE_TABLE[model] || PRICE_TABLE['mock-model'];
  return (
    (usage.inputTokens * p.input
      + usage.outputTokens * p.output
      + usage.cacheReadTokens * p.cacheRead
      + usage.cacheWriteTokens * p.cacheWrite)
    / 1_000_000
  );
}

/**
 * 把 AI SDK 返回的 usage 对象规范化成四类 token。
 *
 * AI SDK v5 把 cache read 标准化到顶层 `cachedInputTokens`（OpenAI、DashScope 都映射到这里）。
 * cache write 没有 AI SDK 标准字段，Anthropic provider 元数据用 `cacheCreationInputTokens`。
 * 这里把两个来源都兜一遍，以后接新 provider 就在对应位置补一行。
 */
export function normalizeUsage(usage: any): StepUsage {
  // 某些失败或无输出的调用可能没有 usage，统一返回零值可简化上层统计逻辑。
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // ?? 只在左侧为 null/undefined 时回退，因此合法的 0 不会被误判为缺失。
  const cacheRead =
    usage.cachedInputTokens                                        // AI SDK 标准字段
    ?? usage.providerMetadata?.openai?.cachedTokens                // OpenAI 原生
    ?? 0;

  const cacheWrite =
    usage.cacheCreationInputTokens                                 // Anthropic SDK 直接挂顶层
    ?? usage.providerMetadata?.anthropic?.cacheCreationInputTokens // AI SDK 走 provider 元数据
    ?? 0;

  // OpenAI 把 cached tokens 含在 inputTokens 总数里 → 减出来；Anthropic 单列 → 不用减
  let inputTokens = usage.inputTokens ?? 0;
  // >= 同时避免重复扣减导致负数，也兼容已经把缓存 token 单列出来的 provider。
  if (cacheRead && inputTokens >= cacheRead) inputTokens -= cacheRead;

  return {
    // 最后一层防御：即使上游返回异常负值，也不让普通输入 token 进入负数区间。
    inputTokens: Math.max(0, inputTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
