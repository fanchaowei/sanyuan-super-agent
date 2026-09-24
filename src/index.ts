/**
 * 使用 SQLite + sqlite-vec + FTS5 处理 RAG 的版本
 */

import { createOpenAI } from '@ai-sdk/openai'
import { type ModelMessage } from 'ai'
import 'dotenv/config'
import fs from 'node:fs'
import { createInterface } from 'node:readline'
import { agentLoop } from './agent/agent-loop'
import { FeishuChannel } from './channels/feishu'
import { ChannelGateway } from './channels/gateway'
import { createDispatcher, type CommandContext } from './commands'
import { createAgentCommands } from './commands/agents'
import { createChannelCommands } from './commands/channel.js'
import { contextCommands } from './commands/context'
import { createCronCommands } from './commands/cron'
import { debugCommands } from './commands/debug'
import { dreamCommands } from './commands/dream'
import { memoryCommands } from './commands/memory'
import { createPluginCommands } from './commands/plugin'
import { ragCommands } from './commands/rag'
import { createSecurityCommands } from './commands/security.js'
import { createSkillCommands } from './commands/skill'
import { estimateMessageTokens } from './context/defense'
import {
  PromptBuilder, coreRules,
  deferredTools, sessionContext,
  toolGuide,
  type PromptContext,
} from './context/prompt-builder.js'
import { memoryContext, ragContext } from './context/prompt-pipes'
import { CronService } from './cron/service'
import { connectMCP } from './mcp'
import { MemoryStore } from './memory/store'
import { registerMockSecurityHook } from './mock'
import { createMockModel } from './mock-model'
import { PluginManager } from './plugins/manager.js'
import { supabasePlugin } from './plugins/supabase-plugin'
import type { PluginDefinition } from './plugins/types'
import { chunkDocument } from './rag/chunker'
import { createDashScopeEmbedder, createMockEmbedder, embed } from './rag/embedder'
import { SqliteVectorStore } from './rag/sqlite-store.js'
import { HookPipeline } from './security/hooks.js'
import { SessionStore } from './session/store'
import { SkillLoader } from './skills/loader'
import { SubAgentRegistry } from './sub-agents/registry'
import { SpawnContext } from './sub-agents/spawn'
import { allTools } from './tools'
import { createCronTool } from './tools/cron-tools'
import { createMemoryTool } from './tools/memory-tools'
import { createRagTools } from './tools/rag-tools'
import { createSpawnTool } from './tools/spawn-tools'
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

// ———— Skills ——————————————————————————————
const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ———— Plugins ——————————————————————————————
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
]);

const countPluginTools = async () => {
  // 启动时自动加载插件
  console.log('  加载插件...');
  for (const [name, def] of availablePlugins) {
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${name} — ${tools.length} 个工具`);
    } catch {
      console.log(`  ✗ ${name} — 加载失败`);
    }
  }
}

// ———— Security: Hook Pipeline ——————————————————————————————

const hookPipeline = new HookPipeline();

// 注册模拟的 hook
registerMockSecurityHook(hookPipeline)

registry.setHookPipeline(hookPipeline);

// ———— Channel ——————————————————————————————
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => builder.build(makePromptCtx()),
});

const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');
const feishuChannel = new FeishuChannel({
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  port: FEISHU_PORT,
});
gateway.register(feishuChannel);

// ———— Cron Service ——————————————————————————————

const cronService = new CronService({ baseDir: '.' });
registry.register(createCronTool(cronService));

const setCronServiceExecutor = (cronService: CronService) => {
  cronService.setExecutor({
    runAgentPrompt: async (prompt, timeout) => {
      const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
      const system = builder.build(makePromptCtx());
      await agentLoop(model, registry, cronMessages, system);
      const lastMsg = cronMessages[cronMessages.length - 1];
      if (!lastMsg) return '(无输出)';
      if (typeof lastMsg.content === 'string') return lastMsg.content;
      if (Array.isArray(lastMsg.content)) {
        return lastMsg.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') || '(无输出)';
      }
      return String(lastMsg.content);
    },
    notify: (message) => {
      console.log(`\n${message}`);
    },
  });
}

// ── Sub-Agent ────────────────────────────────────────
const agentRegistry = new SubAgentRegistry({ maxSpawnDepth: 1, maxConcurrent: 3 });

function getSpawnCtx(): SpawnContext {
  return {
    model,
    registry,
    agentRegistry,
    buildSystem: () => builder.build(makePromptCtx()),
    currentDepth: 0,
  };
}

registry.register(createSpawnTool(agentRegistry, getSpawnCtx));

// ———— Commands ——————————————————————————————
// 命令按数组顺序尝试匹配；因此更具体的命令处理器应放在更通用的处理器之前。

const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands,
  ...dreamCommands,
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
  ...createChannelCommands(gateway),
  ...createSecurityCommands(registry, hookPipeline),
  ...createCronCommands(cronService),
  ...createAgentCommands(agentRegistry),
]);

// ———— Prompt Builder ——————————————————————————————

// Prompt Pipe 只组装 system prompt；它不在 messages 中。
const builder = new PromptBuilder()
  .pipe('coreRules', coreRules())
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('memoryContext', memoryContext(memoryStore))
  .pipe('ragContext', ragContext(vectorStore))
  .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
  .pipe('sessionContext', sessionContext());

// 每次构建 prompt 前重新计算上下文，确保工具数量和消息数量反映最新状态。
function makePromptCtx(): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: 0,
    sessionId: 'default',
  };
}

/**
 * 程序入口：完成工具与会话初始化，然后启动命令行对话循环。
 */
async function main() {
  // 先连接真实或 Mock MCP，使后续工具统计和模型调用能拿到完整的工具集合。
  await connectMCP(registry)

  // 启动时自动加载插件
  await countPluginTools()

  // 输出活跃工具、延迟工具及其 Schema 大致占用的 token。
  countTools()

  // 启动 Channel
  console.log('  启动 Channel...');
  await gateway.startAll();

  // 加载并开始定时任务
  cronService.load()
  setCronServiceExecutor(cronService)
  cronService.start()
  const cronJobs = cronService.list()
  console.log(`  Cron: ${cronJobs.length} 个任务已加载`)

  // messages 是对话的单一事实来源：用户输入先写入，agentLoop 产生的 assistant/tool
  // 消息再追加到同一个数组，随后统一持久化。
  let messages: ModelMessage[] = [];

  const timestamps = new Map<number, number>();

  // 恢复持久化会话。
  const session = initializeSession(messages);
  messages = session.messages;
  const { sessionId, store } = session;

  const tracker = new UsageTracker('.usage/today.jsonl');


  // node readline 模块
  // 创建一个命令行交互对象，让程序可以从中断读取用户输入，并把提示活输出显示到终端
  const rl = createInterface({
    input: process.stdin, // 标准输入，键盘输入
    output: process.stdout, // 标准输出，终端显示
  })


  // 递归安排下一次 readline 提问，形成串行交互：上一轮 agentLoop 完成后才接收下一轮输入。
  function ask() {
    // 提问并等待用户输入
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!')
        cronService.stop()
        await gateway.stopAll();
        await pluginManager.unloadAll();
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

  const role = registry.getRole();
  const toolCount = registry.getActiveTools().length;
  const hooks = hookPipeline.list();

  console.log('Super Agent v0.19 — Sub-Agent (type "exit" to quit)');
  console.log('快捷命令：');
  console.log('  /agents           — 查看子 Agent 记录');
  console.log('  /cron             — 查看定时任务');
  console.log('  /role [角色]      — 查看/切换角色');
  console.log('');
  console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
  console.log(`  Sub-Agent: 最大深度 ${agentRegistry.getConfig().maxSpawnDepth}，最大并发 ${agentRegistry.getConfig().maxConcurrent}`);
  console.log('');
  console.log('  试试：');
  console.log('    帮我对比 Hono、Fastify 和 Express 的性能和生态');
  console.log('    /agents       — 查看子 Agent 执行记录');
  console.log('');

  const pluginList = pluginManager.list();
  if (pluginList.length > 0) {
    console.log(`  已加载 ${pluginList.length} 个插件：`);
    for (const p of pluginList) {
      console.log(`    ${p.name} — ${p.tools.join(', ')}`);
    }
    console.log('');
  }

  if (loadedSkills.length > 0) {
    console.log(`  发现 ${loadedSkills.length} 个 skill：`);
    for (const s of loadedSkills) console.log(`    /${s.name} — ${s.description}`);
    console.log('');
  }

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
