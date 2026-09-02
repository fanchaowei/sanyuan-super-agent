import { createOpenAI } from '@ai-sdk/openai'
import { type ModelMessage } from 'ai'
import 'dotenv/config'
import { createInterface } from 'node:readline'
import { agentLoop, type BudgetState } from './agent/agent-loop'
// import { MCPClient, MockMCPClient } from './mcp/mcp-client'
import { estimateTokens, microcompact, summarize } from './context/compressor'
import {
  PromptBuilder, coreRules,
  deferredTools, sessionContext,
  toolGuide,
  type PromptContext,
} from './context/prompt-builder.js'
import { textToolResultOutput } from './context/tool-result-output'
import { MCPClient, MockMCPClient } from './mcp/mcp-client-sdk'
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
  const simulatedTools: ToolDefinition[] = [
    // Notion MCP 模拟
    { name: 'mcp__notion__search_pages', description: '[MCP:notion] 搜索 Notion 页面', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, shouldDefer: true, searchHint: 'notion search pages documents', isConcurrencySafe: true, isReadOnly: true, execute: async ({ query }: any) => JSON.stringify([{ title: `Mock: ${query}`, id: 'page-001' }]) },
    { name: 'mcp__notion__create_page', description: '[MCP:notion] 创建 Notion 页面', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title'] }, shouldDefer: true, searchHint: 'notion create page document write', isConcurrencySafe: false, isReadOnly: false, execute: async ({ title }: any) => `已创建页面: ${title}` },
    { name: 'mcp__notion__list_databases', description: '[MCP:notion] 列出 Notion 数据库', parameters: { type: 'object', properties: {}, required: [] }, shouldDefer: true, searchHint: 'notion list databases tables', isConcurrencySafe: true, isReadOnly: true, execute: async () => JSON.stringify([{ title: '项目追踪', id: 'db-001' }, { title: '知识库', id: 'db-002' }]) },

    // Playwright MCP 模拟
    { name: 'mcp__browser__navigate', description: '[MCP:browser] 导航到指定 URL', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, shouldDefer: true, searchHint: 'browser navigate open url webpage', isConcurrencySafe: false, isReadOnly: false, execute: async ({ url }: any) => `已导航到 ${url}` },
    { name: 'mcp__browser__screenshot', description: '[MCP:browser] 对当前页面截图', parameters: { type: 'object', properties: {} }, shouldDefer: true, searchHint: 'browser screenshot capture page', isConcurrencySafe: true, isReadOnly: true, execute: async () => '[screenshot data]' },
    { name: 'mcp__browser__click', description: '[MCP:browser] 点击页面元素', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }, shouldDefer: true, searchHint: 'browser click element button', isConcurrencySafe: false, isReadOnly: false, execute: async ({ selector }: any) => `已点击 ${selector}` },
    { name: 'mcp__browser__fill', description: '[MCP:browser] 在输入框中填写内容', parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] }, shouldDefer: true, searchHint: 'browser fill input form text', isConcurrencySafe: false, isReadOnly: false, execute: async ({ selector, value }: any) => `已在 ${selector} 填写 ${value}` },
    { name: 'mcp__browser__get_text', description: '[MCP:browser] 获取页面文本内容', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }, shouldDefer: true, searchHint: 'browser get text content extract', isConcurrencySafe: true, isReadOnly: true, execute: async ({ selector }: any) => `Mock text content of ${selector}` },

    // Supabase MCP 模拟
    { name: 'mcp__supabase__query', description: '[MCP:supabase] 执行 SQL 查询', parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }, shouldDefer: true, searchHint: 'database sql query select', isConcurrencySafe: true, isReadOnly: true, execute: async ({ sql }: any) => JSON.stringify([{ id: 1, name: 'mock_row', sql }]) },
    { name: 'mcp__supabase__list_tables', description: '[MCP:supabase] 列出数据库所有表', parameters: { type: 'object', properties: {} }, shouldDefer: true, searchHint: 'database list tables schema', isConcurrencySafe: true, isReadOnly: true, execute: async () => JSON.stringify(['users', 'orders', 'products']) },
    { name: 'mcp__supabase__describe_table', description: '[MCP:supabase] 查看表结构', parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] }, shouldDefer: true, searchHint: 'database describe table columns schema', isConcurrencySafe: true, isReadOnly: true, execute: async ({ table }: any) => JSON.stringify({ table, columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] }) },
  ];

  registry.register(...simulatedTools);
  return simulatedTools.length;
}

async function main() {
  await connectMCP()

  const simCount = registerSimulatedTools();
  console.log(`  已注册 ${simCount} 个模拟 MCP 工具（Notion/Browser/Supabase）`);

  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`);

  // 对话历史，包含 role 和 content
  let messages: ModelMessage[] = []

  // Session 持久化
  const isContinue = process.argv.includes('--continue');
  const sessionId = 'default';
  const store = new SessionStore(sessionId);

  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`);
  } else {
    // 注入模拟历史，演示压缩效果
    injectFakeHistory(messages);
    console.log(`\n[Session] 新会话 "${sessionId}"`);
  }

  //#region 压缩演示
  let summary = '';

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

  //#endregion

  // Prompt Pipe 组装 system prompt
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

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(promptCtx)

  // node readline 模块
  // 创建一个命令行交互对象，让程序可以从中断读取用户输入，并把提示活输出显示到终端
  const rl = createInterface({
    input: process.stdin, // 标准输入，键盘输入
    output: process.stdout, // 标准输出，终端显示
  })


  // 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
  const budget: BudgetState = { used: 0, limit: 50000 };

  function ask() {
    // 提问并等待用户输入
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!')
        rl.close()
        return
      }

      const userMsg: ModelMessage = { role: 'user', content: trimmed };

      // 将用户本次的输入加入到 message
      messages.push(userMsg);
      store.append(userMsg);

      const beforeLen = messages.length;

      await agentLoop(model, registry, messages, SYSTEM, budget)

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      store.appendAll(newMessages);

      ask()
    })
  }

  console.log('\nSuper Agent v0.6 — Dynamic Tools (type "exit" to quit)');
  console.log('试试："查看 vercel/ai 的 issues"（会触发 tool_search）\n');
  ask()
}

function injectFakeHistory(messages: ModelMessage[]) {
  const fakeHistory: ModelMessage[] = [
    { role: 'user', content: '帮我看看当前目录有什么文件' },
    { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'fake-1', toolName: 'list_directory', input: { path: '.' } }] },
    { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'fake-1', toolName: 'list_directory', output: textToolResultOutput('[FILE] .env\n[DIR] node_modules\n[FILE] package.json\n[FILE] sample-data.txt\n[DIR] src\n[FILE] tsconfig.json') }] },
    { role: 'assistant', content: [{ type: 'text' as const, text: '当前目录有以下文件：.env, package.json, sample-data.txt, tsconfig.json，以及 src 和 node_modules 两个目录。' }] },
    { role: 'user', content: '读一下 package.json' },
    { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'fake-2', toolName: 'read_file', input: { path: 'package.json' } }] },
    { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'fake-2', toolName: 'read_file', output: textToolResultOutput('{\n  "name": "super-agent-08-compaction",\n  "version": "0.8.0",\n  "type": "module",\n  "scripts": { "start": "tsx src/index.ts" },\n  "dependencies": { "ai": "5.0.98", "@ai-sdk/openai": "2.0.44" }\n}') }] },
    { role: 'assistant', content: [{ type: 'text' as const, text: 'package.json 的内容：项目名 super-agent-08-compaction，版本 0.8.0，依赖 ai 和 @ai-sdk/openai。' }] },
    { role: 'user', content: '读一下 sample-data.txt' },
    { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'fake-3', toolName: 'read_file', input: { path: 'sample-data.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'fake-3', toolName: 'read_file', output: textToolResultOutput('Super Agent 工具系统设计文档\n=============================\n\n一、工具注册机制\n每个工具通过 ToolRegistry 统一注册，提供名称、描述、参数 Schema 和执行函数。\n\n二、结果截断策略\nHead/Tail 60/40 分割，保留文件头部和尾部的关键信息。\n\n三、并发控制\n读写锁模式：只读工具共享锁，读写工具独占锁。\n\n四、最佳实践\n1. 工具描述要写"什么时候不该用"比"能干什么"更有价值\n2. 参数描述要具体——"必须是绝对路径"能防一大类错误\n3. 错误信息要对模型友好——模型需要理解为什么失败才能换策略\n4. 结果格式要结构化——JSON 比自然语言更容易被模型准确解析') }] },
    { role: 'assistant', content: [{ type: 'text' as const, text: 'sample-data.txt 是一份工具系统设计文档，包含四个部分：工具注册机制、结果截断策略、并发控制和最佳实践。' }] },
    { role: 'user', content: '帮我搜索一下 src 目录里有哪些 export' },
    { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'fake-4', toolName: 'grep', input: { pattern: 'export', path: 'src' } }] },
    { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'fake-4', toolName: 'grep', output: textToolResultOutput('src/tools.ts:1: export const weatherTool\nsrc/tools.ts:20: export const calculatorTool\nsrc/tools.ts:40: export const readFileTool\nsrc/tool-registry.ts:4: export interface ToolDefinition\nsrc/tool-registry.ts:18: export class ToolRegistry\nsrc/agent-loop.ts:7: export async function agentLoop\nsrc/session-store.ts:8: export class SessionStore\nsrc/prompt-builder.ts:12: export class PromptBuilder\nsrc/context-compressor.ts:30: export function microcompact\nsrc/context-compressor.ts:80: export async function summarize') }] },
    { role: 'assistant', content: [{ type: 'text' as const, text: 'src 目录里的主要导出：tools.ts 导出了各种工具定义，tool-registry.ts 导出了 ToolRegistry 类，agent-loop.ts 导出了 agentLoop 函数，还有 SessionStore、PromptBuilder、microcompact 和 summarize 等。' }] },
  ];
  messages.push(...fakeHistory);
}

main().catch(console.error);