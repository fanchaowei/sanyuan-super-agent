import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry } from './store.js';

/** 单条记忆校验过程中发现的问题。 */
export interface ValidationIssue {
  /** 问题类型：失效路径、长期未使用或名称重复。 */
  kind: 'stale_path' | 'never_used' | 'duplicate_name';
  /** 面向用户的中文问题描述。 */
  message: string;
}

/** 单条存在问题的记忆及其全部校验结果。 */
export interface ValidationReport {
  /** 被校验的原始记忆条目。 */
  entry: MemoryEntry;
  /** 当前记忆中发现的问题列表。 */
  issues: ValidationIssue[];
}

/**
 * 从普通文本中识别常见代码、配置、文档及脚本文件路径的正则表达式。
 *
 * 负向后行断言用于避免从单词或已有路径中间开始匹配，捕获组则保留完整路径。
 */
const PATH_RE = /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g;

/**
 * 从记忆内容中提取不重复的文件路径。
 *
 * 处理流程：使用路径正则遍历全部匹配项 → 将捕获到的路径写入 Set 去重 →
 * 转换为普通数组并按首次出现顺序返回。
 *
 * @param content 待分析的记忆文本内容。
 * @returns 内容中出现的不重复文件路径列表。
 */
export function extractPaths(content: string): string[] {
  // Set 用于避免同一路径在一条记忆中被重复校验和报告。
  const paths = new Set<string>();
  // matchAll 会返回正则的全部匹配结果，其中下标 1 是路径捕获组。
  for (const match of content.matchAll(PATH_RE)) {
    paths.add(match[1]);
  }
  return Array.from(paths);
}

/** 不同记忆类型允许的最长未读取天数。 */
const TTL_BY_TYPE: Record<string, number> = {
  user: 365,       // 用户偏好较稳定，保留一年。
  feedback: 90,    // 纠正反馈保留约三个月。
  project: 30,     // 项目决策变化较快，每月检查一次。
  reference: 14,   // 外部资源引用容易失效，需要更频繁地检查。
};

/**
 * 校验单条记忆中的路径有效性和使用时效性。
 *
 * 处理流程：
 * 1. 从记忆正文中提取所有文件路径。
 * 2. 将相对路径基于 baseDir 转为待检查路径，并报告不存在的引用。
 * 3. 如果记忆有最后读取时间，则根据记忆类型选择保质期。
 * 4. 计算距最后读取经过的天数，并报告超过保质期的记忆。
 * 5. 返回当前记忆发现的全部问题。
 *
 * @param entry 待校验的记忆条目。
 * @param baseDir 相对路径解析所基于的目录，默认为当前目录。
 * @returns 当前记忆的问题列表；没有问题时返回空数组。
 */
export function validateEntry(
  entry: MemoryEntry,
  baseDir = '.',
): ValidationIssue[] {
  // 按发现顺序收集路径和时效性问题。
  const issues: ValidationIssue[] = [];

  // 先校验正文中引用的每一个不重复路径。
  const paths = extractPaths(entry.content);
  for (const p of paths) {
    // 绝对路径直接使用，相对路径则基于调用方提供的目录解析。
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
    if (!fs.existsSync(abs)) {
      issues.push({
        kind: 'stale_path',
        message: `引用的路径不存在：${p}`,
      });
    }
  }

  // 只有记录过读取时间的记忆才能计算长期未使用天数。
  if (entry.lastReadAt) {
    // 未配置的记忆类型使用 30 天作为默认保质期。
    const staleDays = TTL_BY_TYPE[entry.type] ?? 30;
    // 将当前时间与最后读取时间的毫秒差换算为天数。
    const days = (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24);
    if (days > staleDays) {
      issues.push({
        kind: 'never_used',
        message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
      });
    }
  }

  return issues;
}

/**
 * 批量检查记忆列表，并仅返回存在问题的记忆报告。
 *
 * 处理流程：
 * 1. 预先统计每个记忆名称的出现次数，用于识别重名记录。
 * 2. 逐条调用 {@link validateEntry} 检查路径和使用时效性。
 * 3. 名称出现多次时，为当前记忆追加重复名称问题。
 * 4. 过滤无问题的记忆，仅汇总需要处理的报告。
 *
 * @param entries 待批量检查的全部记忆条目。
 * @param baseDir 相对文件路径的解析基准目录，默认为当前目录。
 * @returns 仅包含问题记忆的校验报告列表。
 */
export function lintAll(
  entries: MemoryEntry[],
  baseDir = '.',
): ValidationReport[] {
  // 最终报告仅保存至少包含一个问题的记忆。
  const reports: ValidationReport[] = [];

  // 名称计数表用于在正式校验前确定哪些名称发生重复。
  const nameCount = new Map<string, number>();
  for (const e of entries) {
    nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
  }

  // 合并单条校验问题与跨条目的名称重复问题。
  for (const entry of entries) {
    const issues = validateEntry(entry, baseDir);
    if ((nameCount.get(entry.name) || 0) > 1) {
      issues.push({
        kind: 'duplicate_name',
        message: `存在 ${nameCount.get(entry.name)} 条同名记忆，可能需要合并`,
      });
    }
    if (issues.length > 0) reports.push({ entry, issues });
  }

  return reports;
}
