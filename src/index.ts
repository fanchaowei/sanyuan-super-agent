import { createOpenAI } from '@ai-sdk/openai'
import { streamText, type ModelMessage } from 'ai'
import 'dotenv/config'
import { createInterface } from 'node:readline'
import { createMockModel } from './mock-model'

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
      system: `你是 Super Agent，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      messages,
    })

    process.stdout.write('Assistant: ')
    let fullResponse = ''
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk)
      fullResponse += chunk
    }
    console.log() // 换行

    messages.push({ role: 'assistant', content: fullResponse })

    ask()
  })
}

console.log('Super Agent v0.1 (type "exit" to quit)\n')
ask()
