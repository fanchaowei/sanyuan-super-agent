import { createOpenAI } from '@ai-sdk/openai'
import { type ModelMessage } from 'ai'
import 'dotenv/config'
import { createInterface } from 'node:readline'
import { agentLoop } from './agent/agent-loop'
// import { MCPClient, MockMCPClient } from './mcp/mcp-client'
import {
  estimateTokens,
  microcompact,
  remapTimestampsAfterCompaction,
  summarize,
} from './context/compressor'
import {
  TokenTracker,
  applyDefense,
  estimateMessageTokens
} from './context/defense.js'
import {
  PromptBuilder, coreRules,
  deferredTools, sessionContext,
  toolGuide,
  type PromptContext,
} from './context/prompt-builder.js'
import { textToolResultOutput } from './context/tool-result-output'
import { MCPClient, MockMCPClient } from './mcp/mcp-client-sdk'
import { simulatedTools } from './mock'
import { createMockModel } from './mock-model'
import { SessionStore } from './session/store'
import { ToolRegistry, type ToolDefinition } from './tools/tool-registry'
import { allTools } from './tools/tools'

/**
 * SDK 自动循环
 */
const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model: any = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel()

// 注册工具
const registry = new ToolRegistry()
registry.register(...allTools)

// 注册 tool_search 元工具
const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query);
    if (results.length === 0) {
      return `没有找到匹配 "${query}" 的工具`;
    }
    return results.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};

registry.register(toolSearchTool);

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...');
    try {
      const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
      const args = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npx', '-y', '@modelcontextprotocol/server-github']
        : ['-y', '@modelcontextprotocol/server-github'];

      const client = new MCPClient(
        command,
        args,
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      )
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
      console.log('  降级为 Mock MCP...');
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
  }

  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer('github', mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// 模拟额外的 MCP 工具（演示工具膨胀问题）
function registerSimulatedTools() {
  registry.register(...simulatedTools);
  return simulatedTools.length;
}

// 注册工具
function registerTools() {
  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`);
}

// 初始化 Session，并根据启动参数恢复历史消息
function initializeSession(messages: ModelMessage[]) {
  const isContinue = process.argv.includes('--continue');
  const sessionId = 'default';
  const store = new SessionStore(sessionId);

  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`);
  } else {
    console.log(`\n[Session] 新会话 "${sessionId}"`);
  }

  return { messages, sessionId, store };
}

// 对上下文执行微型压缩和摘要压缩
async function compactContext(messages: ModelMessage[], summary = '') {
  const beforeTokens = estimateTokens(messages);
  console.log(`\n[压缩前] ${messages.length} 条消息, ~${beforeTokens} tokens`);

  // Layer 1: Microcompact
  const mc = microcompact(messages);
  messages = mc.messages;
  const afterMCTokens = estimateTokens(messages);
  console.log(`[Layer 1: Microcompact] 清理了 ${mc.cleared} 个工具结果, ~${afterMCTokens} tokens`);

  // Layer 2: LLM Summarization
  const compResult = await summarize(model, messages, summary);
  messages = compResult.messages;
  summary = compResult.summary;
  const afterSumTokens = estimateTokens(messages);

  if (compResult.compressedCount > 0) {
    console.log(`[Layer 2: Summarization] 压缩了 ${compResult.compressedCount} 条消息, ~${afterSumTokens} tokens`);
    console.log(`[摘要预览] ${summary.slice(0, 150)}...`);
  } else {
    console.log(`[Layer 2: Summarization] 未触发（消息量不够）`);
  }

  console.log(`[压缩后] ${messages.length} 条消息, ~${afterSumTokens} tokens (节省 ${beforeTokens - afterSumTokens} tokens)\n`);

  return { messages, summary, compressedCount: compResult.compressedCount };
}

/**
 * 程序入口：完成工具与会话初始化，然后启动命令行对话循环。
 *
 * 与本章“三层即时防线”相关的状态有三份：
 * - messages：真正会发送给模型的上下文，也是防御函数直接处理的数据；
 * - timestamps：按 messages 的数组索引记录创建时间，供 Layer 3 判断消息年龄；
 * - tracker：保存最近一次精确输入 token 基线及后续消息字符增量，用于快速估算状态。
 *
 * applyDefense() 负责执行实际防御，顺序为 Layer 2 动态截断、Layer 3 TTL 清理，
 * 最后由 Layer 1 对处理后的消息估算 token；tracker 则同步记录防御前后的字符差值。
 */
async function main() {
  // 先连接真实或 Mock MCP，使后续工具统计和模型调用能拿到完整的工具集合。
  await connectMCP()

  // 注册额外的模拟 MCP 工具，用于演示工具定义过多带来的上下文膨胀。
  const simCount = registerSimulatedTools();
  console.log(`  已注册 ${simCount} 个模拟 MCP 工具（Notion/Browser/Supabase）`);

  // 输出活跃工具、延迟工具及其 Schema 大致占用的 token。
  registerTools()

  // messages 与 timestamps 必须保持相同的索引语义：消息增删或重排后要同步维护时间戳。
  let messages: ModelMessage[] = [];
  let timestamps = new Map<number, number>();

  // 恢复持久化会话；没有可恢复会话时会注入带时间戳的模拟历史用于防御演示。
  const session = initializeSession(messages);
  messages = session.messages;
  const { sessionId, store } = session;

  // 正式对话从空上下文开始，此时 tracker 的 0 基线与 messages 完全一致。
  const tracker = new TokenTracker();
  // 保存最近一次摘要，后续压缩会将它与新产生的旧历史再次合并，避免遗忘更早信息。
  let summary = '';

  // Prompt Pipe 只组装 system prompt；它不在 messages 中，也不参与下面的 TTL 清理。
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext());

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  };

  const SYSTEM = builder.build(promptCtx);

  // 显示 Prompt Pipe 各模块状态，便于观察最终 system prompt 的组成。
  builder.debug(promptCtx)

  // node readline 模块
  // 创建一个命令行交互对象，让程序可以从中断读取用户输入，并把提示活输出显示到终端
  const rl = createInterface({
    input: process.stdin, // 标准输入，键盘输入
    output: process.stdout, // 标准输出，终端显示
  })

  // 教学快捷命令：直接修改当前上下文或执行防御，不发起模型调用。
  function handleQuickTrigger(cmd: string): boolean {
    const now = Date.now();

    if (cmd === '模拟长对话' || cmd === 'sim') {
      console.log('\n[模拟] 注入 20 条历史消息（含大量工具结果）...');
      const beforeLen = messages.length;
      for (let i = 0; i < 5; i++) {
        // 为每组模拟消息制造不同年龄，确保能覆盖未过期、软 TTL 和硬 TTL 场景。
        const age = (20 - i * 4) * 60 * 1000;
        const userIdx = messages.length;
        messages.push({ role: 'user', content: `第 ${i + 1} 轮：帮我读文件 file-${i}.ts` });
        timestamps.set(userIdx, now - age);
        messages.push({ role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: `sim-${i}`, toolName: 'read_file', input: { path: `file-${i}.ts` } }] });
        timestamps.set(userIdx + 1, now - age);
        const bigContent = `// file-${i}.ts\n` + 'export function handler() {\n  // ...\n}\n'.repeat(200);
        messages.push({ role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: `sim-${i}`, toolName: 'read_file', output: textToolResultOutput(bigContent) }] });
        timestamps.set(userIdx + 2, now - age);
        messages.push({ role: 'assistant', content: [{ type: 'text' as const, text: `文件 file-${i}.ts 的内容已读取。` }] });
        timestamps.set(userIdx + 3, now - age);
      }
      // 新注入的历史尚未经过服务端 token 统计，因此先按消息字符数加入 tracker 增量。
      tracker.addMessages(messages.slice(beforeLen));
      const tokens = estimateMessageTokens(messages);
      console.log(`[模拟完成] ${messages.length} 条消息, ~${tokens} tokens\n`);
      return true;
    }

    if (cmd === '执行防线' || cmd === 'defend') {
      console.log('\n--- 执行三层防线 ---');
      const before = estimateMessageTokens(messages);
      const def = applyDefense(messages, timestamps);
      // 先记录新旧消息差值，再把当前上下文切换成防御后的结果。
      tracker.replaceMessages(messages, def.messages);
      messages = def.messages;
      console.log(`  [Layer 2] 截断: ${def.truncated} 条, 预算清理: ${def.compacted} 条`);
      console.log(`  [Layer 3] 软修剪: ${def.softPruned}, 硬清除: ${def.hardPruned}`);
      console.log(`  [结果] ~${before} → ~${def.tokenEstimate} tokens (节省 ${before - def.tokenEstimate})\n`);
      return true;
    }

    if (cmd === '查看状态' || cmd === 'status') {
      // status 基于“最近精确 inputTokens + 后续字符增量”返回当前估算和窗口占比。
      const status = tracker.status;
      const toolMsgs = messages.filter(m => m.role === 'tool').length;
      console.log(`\n[状态] ${messages.length} 条消息 (${toolMsgs} 条工具结果), ~${status.tokens} tokens (${status.percent}%)\n`);
      return true;
    }

    return false;
  }


  // 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
  // const budget: BudgetState = { used: 0, limit: 50000 };

  function ask() {
    // 提问并等待用户输入
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!')
        rl.close()
        return
      }

      if (handleQuickTrigger(trimmed)) {
        ask();
        return;
      }

      const userMsg: ModelMessage = { role: 'user', content: trimmed };

      // 将用户本次的输入加入到 message
      messages.push(userMsg);
      store.append(userMsg);

      // 用户消息还没有被服务端计入 inputTokens，先作为字符增量加入 tracker。
      tracker.addMessage(userMsg);
      // TTL 使用 messages 索引查找创建时间，因此要在 push 后记录当前索引。
      timestamps.set(messages.length - 1, Date.now());

      // 每次请求模型前都执行三层防御，保证真正发出的 messages 已受体积和年龄限制。
      const turnDefense = applyDefense(messages, timestamps);
      // 防御可能截断或替换消息内容，用前后字符差修正 tracker 的 pendingChars。
      tracker.replaceMessages(messages, turnDefense.messages);
      messages = turnDefense.messages;

      // 即时防御后上下文仍达到 75% 时，再启用成本更高的微型压缩和 LLM 摘要。
      if (tracker.status.needsAction) {
        const compactedContext = await compactContext(messages, summary);

        // 压缩会改变消息内容甚至数量，因此 tracker 也要记录压缩前后的字符差。
        tracker.replaceMessages(messages, compactedContext.messages);
        messages = compactedContext.messages;
        summary = compactedContext.summary;

        // 摘要会把旧消息前缀替换为一条新消息，必须同步重映射 TTL 的索引时间戳。
        timestamps = remapTimestampsAfterCompaction(
          timestamps,
          compactedContext.compressedCount,
          messages.length,
        );
      }

      // 记住调用前的长度，agentLoop 返回后即可切出本轮新增的 assistant/tool 消息。
      const beforeLen = messages.length;
      // agentLoop 内会用本轮 inputTokens 校准 tracker，再把响应消息加入 tracker 增量。
      await agentLoop(model, registry, messages, SYSTEM, tracker)

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      store.appendAll(newMessages);

      const now = Date.now();
      // agentLoop 新增的消息统一记录为本轮完成时间，供之后的 TTL 防御判断年龄。
      for (let i = beforeLen; i < messages.length; i++) {
        timestamps.set(i, now);
      }

      // 展示校准后的输入基线加上本轮新增消息所得的下一轮上下文估算。
      const status = tracker.status;
      console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`);

      ask()
    })
  }

  console.log('Super Agent v0.9 — Context Defense (type "exit" to quit)');
  console.log('快捷命令：');
  console.log('  模拟长对话 / sim    — 注入 20 条模拟历史（含大工具结果）');
  console.log('  执行防线 / defend   — 执行三层防线，查看截断和修剪效果');
  console.log('  查看状态 / status   — 查看当前消息数和 token 估算\n');
  ask()
}



main().catch(console.error);
