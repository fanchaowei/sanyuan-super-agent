import { createOpenAI } from '@ai-sdk/openai'
import { type ModelMessage } from 'ai'
import 'dotenv/config'
import { createInterface } from 'node:readline'
import { agentLoop, type BudgetState } from './agent/agent-loop'
import { createMockModel } from './mock-model'
import { ToolRegistry } from './tools/tool-registry'
import { allTools } from './tools/tools'

/**
 * SDK 自动循环
 */

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。需要时主动使用工具获取信息，不要编造数据。回答要简洁直接。`

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

console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? '可并发' : '串行',
    tool.isReadOnly ? '只读' : '读写',
  ].join(', ');
  console.log(`  - ${tool.name}（${flags}）`);
}

// node readline 模块
// 创建一个命令行交互对象，让程序可以从中断读取用户输入，并把提示活输出显示到终端
const rl = createInterface({
  input: process.stdin, // 标准输入，键盘输入
  output: process.stdout, // 标准输出，终端显示
})

// 对话历史，包含 role 和 content
const messages: ModelMessage[] = []

// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 15000 };

function ask() {
  // 提问并等待用户输入
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      rl.close()
      return
    }

    // 将用户本次的输入加入到 message
    messages.push({ role: 'user', content: trimmed })

    await agentLoop(model, registry, messages, SYSTEM, budget)

    ask()
  })
}

console.log('Super Agent v0.4 — Fuses (type "exit" to quit)\n');
console.log('试试输入："测试死循环"、"测试重试"、"测试预算"、"测试截断"、"测试并发"\n');
ask()
