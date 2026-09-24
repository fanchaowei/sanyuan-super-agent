import { type ModelMessage, streamText } from 'ai';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { SubAgentRegistry } from './registry.js';
import type { SpawnRequest } from './types.js';

/**
 * 子代理执行上下文接口 (SpawnContext)
 *
 * 【作用与说明】
 * 封装了派生子 Agent 运行所需的核心依赖与环境参数，包括大模型实例、工具注册表、
 * 状态注册表、系统提示词构造器以及当前的调用层级深度。
 */
export interface SpawnContext {
  /** 大模型驱动实例（如基于 AI SDK 的 OpenAI / DeepSeek 等模型接口） */
  model: any;

  /** 全局工具注册表，用于获取子 Agent 允许调用的工具定义及执行逻辑 */
  registry: ToolRegistry;

  /** 子代理全局注册中心，负责并发限制、嵌套深度检测及任务生命周期状态追踪 */
  agentRegistry: SubAgentRegistry;

  /** 动态构建系统提示词 (System Prompt) 的函数，生成基础角色设定与规则 */
  buildSystem: () => string;

  /** 当前父 Agent 的嵌套深度（主 Agent 深度为 0，派生的子 Agent 深度为 1，依此类推） */
  currentDepth: number;
}

/** 子代理默认单次任务允许执行的最大 ReAct 交互轮数（防止死循环调用工具） */
const SUB_AGENT_MAX_STEPS = 10;

/** 子代理环境中需要屏蔽的工具名称集合（例如禁止子代理再次派生子代理，防止无限递归） */
const EXCLUDED_TOOLS = new Set(['spawn_agent']);

/** ANSI 终端彩色高亮输出代码列表，用于在控制台区分不同子代理的执行日志 */
const AGENT_COLORS = [
  '\x1b[36m',  // 青色 cyan
  '\x1b[33m',  // 黄色 yellow
  '\x1b[35m',  // 洋红 magenta
  '\x1b[32m',  // 绿色 green
  '\x1b[34m',  // 蓝色 blue
];

/** ANSI 终端颜色重置字符 */
const RESET = '\x1b[0m';

/**
 * 生成带有彩色终端高亮和唯一标识的子代理日志前缀标签
 *
 * @param index - 当前子代理在并发列表中的序号索引（用于轮换分配不同颜色）
 * @param runId - 当前子代理的全局唯一运行 ID（例如 sub-1-a8x9）
 * @returns 格式化后的带颜色标签字符串，例如 `[Agent-1:sub-1-a8x9]`
 */
function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}

/**
 * 派生并执行单个子 Agent 任务 (spawnAgent)
 *
 * 【整体执行流程】
 * 1. 【安全与并发门禁】：调用 `agentRegistry.canSpawn` 检查当前嵌套深度与系统并发数是否超限。
 * 2. 【注册与初始化】：生成唯一 `runId` 并将任务状态登记到注册表中，状态标记为 `'running'`。
 * 3. 【提示词与工具装配】：
 *    - 继承并扩展父系统的 System Prompt，注入子代理专门的行为约束（直接输出结论、鼓励并行工具调用）。
 *    - 过滤掉黑名单工具（如 `spawn_agent`），避免子 Agent 无限递归派生。
 * 4. 【超时控制与信号绑定】：创建 `AbortController`，设定超时定时器（默认 60s），超出时自动中断执行。
 * 5. 【ReAct 循环驱动】：
 *    - 在最多 `maxSteps` 轮迭代中，通过 AI SDK 的 `streamText` 与大模型交互。
 *    - 实时监听流式输出并捕获模型发起的 `tool-call`，打印调用日志。
 *    - 将模型响应与工具结果追加回消息历史 `messages`。
 *    - 当模型不再调用工具（直接输出文本）或达到最大步数时退出循环。
 * 6. 【结果提取与状态更新】：提取最后一条由 assistant 产生的文本回复，标记任务为 `completed` 并返回。
 * 7. 【异常与超时降级】：若捕获到中止信号或异常，标记任务为 `error`，并尝试从已有的消息上下文中提取部分已生成的内容作为降级输出。
 *
 * @param request - 派生任务请求对象（包含任务描述 task、超时时间 timeout 等）
 * @param ctx - 子代理运行上下文（包含模型、工具表、注册中心等）
 * @param index - 当前子代理的序号（用于日志标签着色展示）
 * @returns 子 Agent 执行完成后输出的最终文本结果
 */
export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  // 1. 安全门禁校验（嵌套深度与并发数）
  const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!ok) return `[spawn] 拒绝: ${reason}`;

  // 2. 生成运行 ID 并注册任务
  const runId = ctx.agentRegistry.generateId();
  const tag = agentTag(index, runId);
  const run = {
    id: runId,
    task: request.task,
    status: 'running' as const,
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  };
  ctx.agentRegistry.register(run);

  // 3. 超时与轮数配置
  const timeout = request.timeout || 60000;
  const maxSteps = 30;
  const ac = new AbortController();
  console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`);

  // 将 messages 声明在 try 块外部，确保 catch 块在超时或异常时也能安全读取上下文历史
  const messages: ModelMessage[] = [
    { role: 'user', content: request.task },
  ];

  try {
    // 构造子 Agent 专属的 System Prompt
    const system = ctx.buildSystem() +
      '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
      '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。';

    // 获取子 Agent 可用的工具列表（已排除 spawn_agent 工具）
    const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS);

    // 启动超时定时器
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      let step = 0;
      // 4. ReAct 循环：大模型思考 -> 工具调用 -> 观察结果 -> 继续思考
      while (step < maxSteps) {
        step++;
        const isLastStep = step === maxSteps;
        console.log(`  ${tag} Step ${step}/${maxSteps}${isLastStep ? ' (总结)' : ''}`);

        // 若已达到最大步数，提示大模型直接进行总结，不要继续调用工具
        if (isLastStep) {
          messages.push({ role: 'user', content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。' });
        }

        // 调用 AI SDK 发起流式推理
        const result = streamText({
          model: ctx.model,
          system,
          tools,
          toolChoice: isLastStep ? 'none' : 'auto',
          messages,
          maxRetries: 0,
          abortSignal: ac.signal,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => { },
        });

        let hasToolCall = false;
        // 监听流式块，检测是否有工具调用事件并打印调用日志
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            hasToolCall = true;
            const argsPreview = JSON.stringify(part.input).slice(0, 80);
            console.log(`  ${tag} 调用 ${part.toolName}(${argsPreview})`);
          }
        }

        // 等待响应生成完整并将多轮交互消息沉淀到 messages 中
        const response = await result.response;
        messages.push(...response.messages);

        // 如果本轮大模型没有发起任何工具调用，说明已经得出最终结论，可以提前结束循环
        if (!hasToolCall) break;
      }
    } finally {
      // 循环结束或发生异常时，清理超时定时器
      clearTimeout(timer);
    }

    // 5. 从交互历史中倒序提取最后一条 assistant 生成的文本内容
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    let result = '(无输出)';
    if (lastAssistant) {
      if (typeof lastAssistant.content === 'string') {
        result = lastAssistant.content;
      } else if (Array.isArray(lastAssistant.content)) {
        result = lastAssistant.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') || '(无输出)';
      }
    }

    // 6. 更新注册表状态为完成
    ctx.agentRegistry.complete(runId, result);
    console.log(`  ${tag} 完成 ✓ (${result.length} 字符)`);
    return result;
  } catch (err: any) {
    // 7. 异常与超时处理
    const isAbort = err.name === 'AbortError' || ac.signal.aborted;
    const errorMsg = isAbort ? `执行超时 (${timeout / 1000}s)` : (err.message || String(err));
    ctx.agentRegistry.fail(runId, errorMsg);
    console.log(`  ${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`);

    // 超时时尝试提取已经生成的局部文本作为部分结果返回
    if (isAbort) {
      const partial = [...messages].reverse().find(m => m.role === 'assistant');
      if (partial) {
        const text = typeof partial.content === 'string' ? partial.content
          : Array.isArray(partial.content)
            ? partial.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
            : '';
        if (text) return `[部分结果] ${text}`;
      }
    }
    return `[sub-agent 执行失败] ${errorMsg}`;
  }
}

/**
 * 批量并行派生子 Agent (spawnParallel)
 *
 * 【整体执行流程】
 * 1. 【并发容量计算】：查询注册中心配置的 `maxConcurrent` 与当前正在运行的任务数，计算出当前剩余可用并发槽位 `available`。
 * 2. 【任务拆分与截断】：
 *    - 如果可用槽位不足以容纳全部请求，截取前 `available` 个任务进入执行列表 `toRun`。
 *    - 溢出的多余任务放入 `rejected` 拒绝列表，直接给出超额提示，避免系统过载。
 * 3. 【并行并发执行】：利用 `Promise.all` 同时触发 `toRun` 列表中所有子 Agent 的执行，实现并行加速。
 * 4. 【结果合并与汇总】：将已执行任务的结果与被拒绝任务的提示汇总后统一返回。
 *
 * @param requests - 待派生的一组子 Agent 任务请求数组
 * @param ctx - 子代理运行上下文
 * @returns 包含每个任务描述 task 及其执行结果 result 的键值对象数组
 */
export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
  // 1. 获取最大并发限制与当前活跃数，计算可用槽位
  const maxConcurrent = ctx.agentRegistry.getConfig().maxConcurrent;
  const activeCount = ctx.agentRegistry.getActiveRuns().length;
  const available = maxConcurrent - activeCount;

  // 若无可用并发配额，直接拒绝全部请求
  if (available <= 0) {
    return requests.map(r => ({ task: r.task, result: `[spawn] 拒绝: 已达最大并发数 ${maxConcurrent}` }));
  }

  // 2. 根据可用配额拆分：允许执行的任务 vs 溢出拒绝的任务
  const toRun = requests.slice(0, available);
  const rejected = requests.slice(available);
  if (rejected.length > 0) {
    console.log(`  ⚠ 请求 ${requests.length} 个子 Agent，但最大并发为 ${maxConcurrent}，只执行前 ${toRun.length} 个`);
  }

  console.log(`\n  ┌─ 派发 ${toRun.length} 个子 Agent 并行执行 ─┐`);

  // 3. 并行执行允许的子任务
  const results = await Promise.all(
    toRun.map(async (req, i) => {
      const result = await spawnAgent(req, ctx, i);
      return { task: req.task, result };
    })
  );

  // 4. 补充被拒绝任务的说明
  for (const r of rejected) {
    results.push({ task: r.task, result: `[spawn] 拒绝: 超出最大并发数 ${maxConcurrent}，本次未执行` });
  }

  console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
  return results;
}
