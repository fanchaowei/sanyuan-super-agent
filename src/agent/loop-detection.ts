import { createHash } from 'node:crypto';

// --- 类型定义 ---

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

export type DetectionResult =
  | { stuck: false }
  | { stuck: true; level: 'warning' | 'critical'; detector: DetectorKind; count: number; message: string };

// --- 配置 ---

const HISTORY_SIZE = 30;       // 滑动窗口大小
const WARNING_THRESHOLD = 5;   // 警告阈值（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8;  // 严重阈值（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10;  // 熔断阈值（演示用，生产环境通常是 30）

// --- 指纹计算 ---

/**
 * 将任意值转换成稳定的 JSON 字符串。
 *
 * 普通 JSON.stringify 在对象 key 顺序不同时会得到不同字符串；
 * 这里会先按 key 排序，确保 `{ a: 1, b: 2 }` 和 `{ b: 2, a: 1 }`
 * 得到相同结果，方便后续生成稳定哈希。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

/**
 * 计算短哈希指纹。
 *
 * 使用 sha256 后只取前 16 位，目的是让日志和内存记录更短；
 * 这里不是安全校验场景，只需要低碰撞概率的重复检测标识。
 */
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 为一次工具调用生成参数指纹。
 *
 * 结果格式为 `工具名:参数哈希`，这样不同工具即使用了相同参数，
 * 也不会被误判为同一次调用。
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

/**
 * 为工具执行结果生成稳定指纹，用于判断重复调用是否真的产生了新结果。
 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

// --- 滑动窗口 ---

const history: ToolCallRecord[] = [];

/**
 * 记录一次工具调用。
 *
 * 这里只记录工具名、参数指纹和时间戳；执行结果会在 recordResult 中补上。
 * history 是一个固定大小的滑动窗口，超过 HISTORY_SIZE 后丢弃最早记录。
 */
export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift();
}

/**
 * 记录一次工具调用的执行结果。
 *
 * 根据工具名和参数指纹，从后往前找到最近一条还没有结果的调用记录，
 * 再把结果哈希写进去。倒序查找可以优先匹配最新的未完成调用。
 */
export function recordResult(toolName: string, params: unknown, result: unknown): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

/**
 * 清空检测历史。
 *
 * 通常在新会话、新任务或测试前调用，避免旧记录影响新的循环检测。
 */
export function resetHistory(): void {
  history.length = 0;
}

// --- 检测器 ---

/**
 * 计算同一个工具、同一组参数连续产生相同结果的次数。
 *
 * 如果最近多次调用都返回同一个 resultHash，说明 agent 可能没有获得新信息；
 * 一旦遇到不同结果就停止计数，表示可能已经有进展。
 */
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    if (!r.resultHash) continue;
    if (!lastResultHash) { lastResultHash = r.resultHash; streak = 1; continue; }
    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

/**
 * 检测 A/B/A/B 形式的乒乓循环。
 *
 * currentHash 表示即将执行的调用参数指纹；函数会查看历史中最近的调用，
 * 判断是否在两个参数之间来回切换。如果当前调用会延续这种交替模式，
 * 返回交替次数，否则返回 0。
 */
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0;
  const last = history[history.length - 1];
  let otherHash: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) { otherHash = history[i].argsHash; break; }
  }
  if (!otherHash) return 0;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }
  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

// --- 主检测函数 ---

/**
 * 对即将执行的工具调用做循环检测。
 *
 * 检测顺序：
 * 1. 全局熔断：同一工具、同一参数连续得到相同结果，说明完全没有进展。
 * 2. 乒乓循环：调用参数在两个状态之间反复切换。
 * 3. 通用重复：滑动窗口内同一工具、同一参数出现太多次。
 *
 * 返回 stuck=false 表示允许继续执行；返回 stuck=true 时，上层可以根据
 * warning 或 critical 决定提醒模型换思路，或者直接停止 agent loop。
 */
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(toolName, argsHash);

  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'global_circuit_breaker', count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`
    };
  }

  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'ping_pong', count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true, level: 'warning', detector: 'ping_pong', count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`
    };
  }

  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'generic_repeat', count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true, level: 'warning', detector: 'generic_repeat', count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`
    };
  }

  return { stuck: false };
}
