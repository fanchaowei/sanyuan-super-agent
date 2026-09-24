import { Cron } from 'croner';
import type { ScheduleType } from './types.js';

// 默认允许的最小调度间隔（5 秒 = 5000 毫秒）
export const DEFAULT_MIN_INTERVAL_MS = 5000;

export interface ParsedSchedule {
  type: ScheduleType;
  intervalMs?: number;       // interval 类型：固定间隔毫秒数
  cronInstance?: Cron;       // cron 类型：croner 实例，负责计算下次执行时间
  onceAt?: Date;             // once 类型：一次性执行的目标时间
}

const INTERVAL_RE = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i;

/**
 * 解析调度表达式，并进行最小安全间隔校验
 *
 * @param expr - 调度表达式
 * @param minIntervalMs - 最小允许的间隔毫秒数（默认 5000ms）
 */
export function parseSchedule(expr: string, minIntervalMs = DEFAULT_MIN_INTERVAL_MS): ParsedSchedule {
  // 将时间间隔写法转换为毫秒时间，即 'every 5m' -> 'intervalMs: 300000'
  const intervalMatch = expr.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    const multiplier = unit.startsWith('h') ? 3600000
      : unit.startsWith('m') ? 60000
        : 1000;

    // 毫秒时间
    const intervalMs = value * multiplier;

    // 安全检查：如果配置的间隔低于最小允许间隔，抛出异常拦截
    if (intervalMs < minIntervalMs) {
      throw new Error(`调度间隔过短：当前为 ${intervalMs / 1000} 秒，最小允许间隔为 ${minIntervalMs / 1000} 秒`);
    }

    return { type: 'interval', intervalMs };
  }

  // ISO 时间戳
  if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
    const date = new Date(expr);
    if (!isNaN(date.getTime())) {
      return { type: 'once', onceAt: date };
    }
  }

  // Cron 表达式：标准五字段 "分 时 日 月 周"
  // 在规定的时间进行任务执行（这里只负责在规定的时间进行执行，至于执行什么不在此处设置）
  const cronInstance = new Cron(expr);
  return { type: 'cron', cronInstance };
}

export function getNextCronTime(cron: Cron): number {
  return cron.msToNext() ?? 60000;
}