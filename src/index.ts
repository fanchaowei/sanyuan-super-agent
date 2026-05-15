import { createOpenAI } from '@ai-sdk/openai'
import { type ModelMessage } from 'ai'
import 'dotenv/config'
import { createInterface } from 'node:readline'
import { agentLoop } from './agent/agent-loop'
import { createMockModel } from './mock-model'
import { calculatorTool, weatherTool } from './tools/utility-tools'

/**
 * SDK 自动循环
 */

const tools = { get_weather: weatherTool, calculator: calculatorTool }

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。需要时主动使用工具获取信息，不要编造数据。回答要简洁直接。`

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model: any = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel()

// node readline 模块
// 创建一个命令行交互对象，让程序可以从中断读取用户输入，并把提示活输出显示到终端
const rl = createInterface({
  input: process.stdin, // 标准输入，键盘输入
  output: process.stdout, // 标准输出，终端显示
})

// 对话历史，包含 role 和 content
const messages: ModelMessage[] = []

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

    await agentLoop(model, tools, messages, SYSTEM)

    ask()
  })
}

console.log('Super Agent v0.3 — Fuses (type "exit" to quit)\n');
console.log('试试输入："测试死循环"、"测试重试"、"测试预算" 看三层防护效果\n');
ask()
