/**
 * 该文件做三件事：
 * - 注册工具
 * - 查找工具
 * - 转换成 AI SDK 需要的格式
 *
 * 工具共享锁 / 独占锁的整体流程：
 * 1. 在一次对话中，LLM 可能会并行发起多个工具调用。
 * 2. 每个工具在真正执行前，会根据 tool.isConcurrencySafe 决定获取共享锁还是独占锁。
 * 3. 能获取锁的工具会继续执行；暂时不能获取锁的工具会在 while 中等待，
 *    并把当前 Promise 的 resolve 函数放进 waitQueue，等锁释放后被唤醒。
 * 4. 锁释放时，drainQueue 会统一调用 waitQueue 中保存的 resolve 函数，
 *    把所有等待中的工具唤醒；被唤醒不代表已经拿到锁，它们还要回到 while 条件重新判断。
 * 5. 能通过 while 判断的工具继续执行；仍不能通过的工具会再次把新的 resolve 放回 waitQueue，
 *    如此重复，直到本轮工具调用全部执行完成。
 */
import { jsonSchema } from 'ai';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false;          // 当前是否有独占锁持有者，是否有独占工具正在执行
  private concurrentCount = 0;            // 当前共享锁持有数
  private waitQueue: Array<() => void> = [];  // 等待锁释放的异步任务队列

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    // 从等待队列中取出所有的待执行的工具
    const waiting = this.waitQueue.splice(0);
    // resolve() 后这些工具继续执行（执行位置在 acquireConcurrent 和 acquireExclusive 内的 while 循环），然后继续抢锁、排队
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 在真正执行前先按 isConcurrencySafe 获取锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 不管成功还是抛异常，锁都要释放
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

// 内容截断
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;

  /**
   * 当读取的文件内容超出 maxChars 最大字符限制时触发。
   * 最后输出的内容按照前 60% + 后 40% 的比例抽取文件内容的头部和尾部的内容
   */
  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
