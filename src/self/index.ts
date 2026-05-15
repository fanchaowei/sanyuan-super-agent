/**
 * Super Agent v0.2 — Agent Loop
 *
 * 目标：让 AI 从“只会聊天”变成“能调用工具干活”
 *
 * 运行: pnpm start
 *
 * 通关条件：问“北京今天天气怎么样”，Agent 调用 get_weather 工具后给出回答
 */
import 'dotenv/config';

// TODO 1: 导入需要的模块
// 从 'ai' 导入 ModelMessage 类型
// 从 '@ai-sdk/openai' 导入 createOpenAI
// 从 './mock-model' 导入 createMockModel
// 从 'node:readline' 导入 createInterface
// 从 './tools' 导入 weatherTool, calculatorTool
// 从 './agent-loop' 导入 agentLoop
import { createOpenAI } from '@ai-sdk/openai';
import { type ModelMessage } from 'ai';
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { agentLoop } from '../agent/loop';
import { createMockModel } from '../mock-model';
import { calculatorTool, weatherTool } from '../tools/utility-tools';

// TODO 2: 创建模型实例（同上一篇）
const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model: any = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel()

const rl = createInterface({
  input: process.stdin,
  output: process.stdout, // 标准输出，终端显示
})

// TODO 3: 定义工具集和消息历史
const tools = { get_weather: weatherTool, calculator: calculatorTool }

const messages: ModelMessage[] = []

// TODO 4: 定义 system prompt
const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。需要时主动使用工具获取信息，不要编造数据。`

// TODO 5: 实现 ask() 函数，用 agentLoop() 替代 streamText
const ask = () => {
  rl.question('\nYou', async (input) => {
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

// TODO 6: 打印欢迎信息，启动循环

console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n');
ask()