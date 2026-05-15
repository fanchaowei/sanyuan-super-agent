import { createOpenAI } from '@ai-sdk/openai'
import { stepCountIs, streamText, type ModelMessage } from 'ai'
import 'dotenv/config'
import { createInterface } from 'node:readline'
import { createMockModel } from './mock-model'
import { calculatorTool, weatherTool } from './tools/utility-tools'

/**
 * SDK 自动循环
 */

const tools = { get_weather: weatherTool, calculator: calculatorTool }

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。需要时主动使用工具获取信息，不要编造数据。`

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

    const result = streamText({
      model,
      // 定义它的行为风格
      system: SYSTEM,
      messages,
      tools,
      stopWhen: stepCountIs(5), // 当 LLM 需要调用工具时自动调用并循环，次数为 5 次
    })

    process.stdout.write('Assistant: ')
    let fullResponse = ''

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text);
          fullResponse += part.text;
          break;
        case 'tool-call':
          console.log(`\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`);
          break;
        case 'tool-result':
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    console.log() // 换行
    messages.push({ role: 'assistant', content: fullResponse })

    ask()
  })
}

console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n');
ask()
