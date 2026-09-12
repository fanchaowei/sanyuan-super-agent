/**
 * 使用 SQLite + sqlite-vec + FTS5 处理 RAG 的版本
 */

import { createOpenAI } from '@ai-sdk/openai'
import { type ModelMessage } from 'ai'
import 'dotenv/config'
import fs from 'node:fs'
import { createInterface } from 'node:readline'
import { agentLoop } from './agent/agent-loop'
import { createDispatcher, type CommandContext } from './commands'
import { contextCommands } from './commands/context'
import { debugCommands } from './commands/debug'
import { memoryCommands } from './commands/memory'
import { ragCommands } from './commands/rag'
import { estimateMessageTokens } from './context/defense'
import {
  PromptBuilder, coreRules,
  deferredTools, sessionContext,
  toolGuide,
  type PromptContext,
} from './context/prompt-builder.js'
import { connectMCP } from './mcp'
import { MemoryStore } from './memory/store'
import { createMockModel } from './mock-model'
import { chunkDocument } from './rag/chunker'
import { createDashScopeEmbedder, createMockEmbedder, embed } from './rag/embedder'
import { SqliteVectorStore } from './rag/sqlite-store.js'
import { SessionStore } from './session/store'
import { allTools } from './tools'
import { createMemoryTool } from './tools/memory-tools'
import { createRagTools } from './tools/rag-tools'
import { ToolRegistry } from './tools/tool-registry'
import { createToolSearchTool } from './tools/tool-search'
import { UsageTracker } from './usage/tracker'

/**
 * 创建模型适配器：配置了 DashScope Key 时走真实模型，否则使用 Mock 模型，
 * 这样本地开发和测试不必依赖外部服务。
 */
const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model: any = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel()

// ———— 注册工具 ——————————————————————————————
// ToolRegistry 同时保存所有工具和当前“活跃”工具；后者会直接参与本轮 prompt，
// 延迟工具则通过搜索工具按需启用，以控制上下文长度。
const registry = new ToolRegistry()
registry.register(...allTools)
registry.register(createToolSearchTool(registry));

// 输出工具规模及其大致 token 成本，便于观察延迟加载是否达到了预期效果。
function countTools() {
  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`);
}

// ———— RAG ———————————————————————————————————————————

const vectorStore = new SqliteVectorStore('knowledge.db');
const embedFn = process.env.DASHSCOPE_API_KEY
  ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
  : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));

// ———— Session 持久化对话 ——————————————————————————————

// 初始化 Session，并根据启动参数恢复历史消息。
// 这里统一返回消息数组、会话 ID 和存储对象，避免主循环分别管理三份状态。
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

// ———— Memory ——————————————————————————————

const memoryStore = new MemoryStore('.')
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// ———— 注册命令 ——————————————————————————————
// 命令按数组顺序尝试匹配；因此更具体的命令处理器应放在更通用的处理器之前。

const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands
]);

/**
 * 程序入口：完成工具与会话初始化，然后启动命令行对话循环。
 */
async function main() {
  // 先连接真实或 Mock MCP，使后续工具统计和模型调用能拿到完整的工具集合。
  await connectMCP(registry)

  // 注册额外的模拟 MCP 工具，用于演示工具定义过多带来的上下文膨胀。
  // const simCount = registerSimulatedTools(registry);
  // console.log(`  已注册 ${simCount} 个模拟 MCP 工具（Notion/Browser/Supabase）`);

  // 输出活跃工具、延迟工具及其 Schema 大致占用的 token。
  countTools()

  // messages 是对话的单一事实来源：用户输入先写入，agentLoop 产生的 assistant/tool
  // 消息再追加到同一个数组，随后统一持久化。
  let messages: ModelMessage[] = [];

  const timestamps = new Map<number, number>();

  // 恢复持久化会话。
  const session = initializeSession(messages);
  messages = session.messages;
  const { sessionId, store } = session;

  const tracker = new UsageTracker('.usage/today.jsonl');

  // Prompt Pipe 只组装 system prompt；它不在 messages 中。
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', () => memoryStore.buildPromptSection())
    .pipe('sessionContext', sessionContext());


  // node readline 模块
  // 创建一个命令行交互对象，让程序可以从中断读取用户输入，并把提示活输出显示到终端
  const rl = createInterface({
    input: process.stdin, // 标准输入，键盘输入
    output: process.stdout, // 标准输出，终端显示
  })

  // 每次构建 prompt 前重新计算上下文，确保工具数量和消息数量反映最新状态。
  function makePromptCtx(): PromptContext {
    return {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId: sessionId,
    };
  }

  // 递归安排下一次 readline 提问，形成串行交互：上一轮 agentLoop 完成后才接收下一轮输入。
  function ask() {
    // 提问并等待用户输入
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!')
        rl.close()
        return
      }

      const ctx: CommandContext = {
        messages, timestamps, registry, builder, tracker,
        sessionStore: store, model, makePromptCtx, ask, memoryStore, vectorStore
      }

      // 命令处理器可以同步完成、异步接管流程，或返回 false 让输入继续走普通对话路径。
      const handled = dispatch(trimmed, ctx);
      if (handled === 'async') return;
      if (handled) { ask(); return; }

      const userMsg: ModelMessage = { role: 'user', content: trimmed };

      // 将用户本次的输入加入到 message
      messages.push(userMsg);
      store.append(userMsg);
      timestamps.set(messages.length - 1, Date.now());


      const promptCtx = makePromptCtx()
      const currentSystem = builder.build(promptCtx);

      // 显示 Prompt Pipe 各模块状态，便于观察最终 system prompt 的组成。
      builder.debug(promptCtx)

      // 记住调用前的长度，agentLoop 返回后即可切出本轮新增的 assistant/tool 消息。
      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, currentSystem, tracker)

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
      store.appendAll(newMessages);

      console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
      ask()
    })
  }

  console.log('Super Agent v0.13 — Memory Maintenance (type "exit" to quit)');
  console.log('快捷命令：');
  console.log('  ingest <path>   — 导入文档到知识库');
  console.log('  /rag            — 查看知识库状态');
  console.log('  /memory         — 查看记忆（带 ⚠️ 标记）');
  console.log('  /lint           — 扫描记忆库');
  console.log('  /dream          — 记忆整理（lint → 清理 → 合并 → 报告）');
  console.log('  /context        — context 占用矩阵');
  console.log('  status          — 当前状态');
  console.log('');

  // 仅在知识库为空时执行首次自动导入，避免每次启动重复写入 sqlite-vec。
  if (vectorStore.size() === 0 && fs.existsSync('docs')) {
    const files = fs.readdirSync('docs').filter(f => f.endsWith('.md'));
    if (files.length > 0) {
      console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
      for (const f of files) {
        const path = `docs/${f}`;
        const text = fs.readFileSync(path, 'utf-8');
        const chunks = chunkDocument(path, text);
        const embeddings = await embed(embedFn, chunks.map(c => c.text));
        vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));
        console.log(`    ${f} → ${chunks.length} 个片段`);
      }
      console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
    }
  } else if (vectorStore.size() > 0) {
    console.log(`  知识库已有 ${vectorStore.size()} 个片段，跳过自动导入\n`);
  }

  ask()
}



main().catch(console.error);
