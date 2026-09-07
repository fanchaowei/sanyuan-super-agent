import { createOpenAI } from '@ai-sdk/openai'
import { type ModelMessage } from 'ai'
import 'dotenv/config'
import { createInterface } from 'node:readline'
import { agentLoop } from './agent/agent-loop'
// import { MCPClient, MockMCPClient } from './mcp/mcp-client'
import {
  PromptBuilder, coreRules,
  deferredTools, sessionContext,
  toolGuide,
  type PromptContext,
} from './context/prompt-builder.js'
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from './context/views.js'
import { MCPClient, MockMCPClient } from './mcp/mcp-client-sdk'
import { simulatedTools } from './mock'
import { createMockModel } from './mock-model'
import { SessionStore } from './session/store'
import { ToolRegistry, type ToolDefinition } from './tools/tool-registry'
import { allTools } from './tools/tools'
import { UsageTracker } from './usage/tracker.js'

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

function builtInCommand(trimmed: string) {
}

/**
 * 程序入口：完成工具与会话初始化，然后启动命令行对话循环。
 */
async function main() {
  // 先连接真实或 Mock MCP，使后续工具统计和模型调用能拿到完整的工具集合。
  await connectMCP()

  // 注册额外的模拟 MCP 工具，用于演示工具定义过多带来的上下文膨胀。
  const simCount = registerSimulatedTools();
  console.log(`  已注册 ${simCount} 个模拟 MCP 工具（Notion/Browser/Supabase）`);

  // 输出活跃工具、延迟工具及其 Schema 大致占用的 token。
  registerTools()

  let messages: ModelMessage[] = [];

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
      if (trimmed === '/context') {
        const toolDescriptionChars = JSON.stringify(
          registry.getActiveTools().map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        ).length

        const snapshot = buildContextSnapshot({
          modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model',
          modelId: process.env.DASHSCOPE_API_KEY
            ? 'qwen-plus-latest'
            : 'mock-model',
          windowTokens: 1_000_000,
          systemPromptChars: SYSTEM.length,
          toolDescriptionChars,
          memoryChars: 0,
          skillsChars: 0,
          messages,
        })

        console.log(renderContextView(snapshot))
        ask()
        return
      }

      if (trimmed === '/usage') {
        console.log(renderUsageView(tracker))
        ask()
        return
      }

      const userMsg: ModelMessage = { role: 'user', content: trimmed };

      // 将用户本次的输入加入到 message
      messages.push(userMsg);
      store.append(userMsg);

      // 记住调用前的长度，agentLoop 返回后即可切出本轮新增的 assistant/tool 消息。
      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, SYSTEM, tracker)

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      store.appendAll(newMessages);

      ask()
    })
  }

  console.log('Super Agent v0.9 (type "exit" to quit)');
  ask()
}



main().catch(console.error);
