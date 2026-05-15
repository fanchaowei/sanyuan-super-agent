/**
 * Super Agent v0.1 — 你的第一个 AI 对话程序
 *
 * 目标：实现一个能在终端里流式对话的 AI
 *
 * 运行: pnpm dev
 *
 * 默认使用模拟模型，不需要 API Key。
 * 在 .env 里填入 DASHSCOPE_API_KEY 后自动切换到真实 Qwen 模型。
 *
 * 通关条件：跟 AI 聊 3 轮，它能记住你之前说的话
 */
import 'dotenv/config';

// TODO 1: 导入需要的模块
// 从 'ai' 导入 streamText 和 ModelMessage 类型
// 从 '@ai-sdk/openai' 导入 createOpenAI
// 从 './mock-model' 导入 createMockModel
// 从 'node:readline' 导入 createInterface
import { createOpenAI } from '@ai-sdk/openai';
import { ModelMessage, streamText } from 'ai';
import { createInterface } from 'node:readline';
import { createMockModel } from '../mock-model';


// TODO 2: 创建模型实例（mock 优先，有 API Key 自动切换）
// const qwen = createOpenAI({
//   baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
//   apiKey: process.env.DASHSCOPE_API_KEY,
// });
// const model = process.env.DASHSCOPE_API_KEY
//   ? qwen.chat('qwen-plus-latest')
//   : createMockModel();
const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})
const model: any = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen-plus-latest') : createMockModel()



// TODO 3: 创建 readline 接口和消息历史数组
// readline: createInterface({ input: process.stdin, output: process.stdout })
// messages: ModelMessage[] 类型
// 想想：为什么需要把历史传给模型？它自己不记事吗？
const rl = createInterface({
  input: process.stdin,
  output: process.stdout
})

const messages: ModelMessage[] = []


// TODO 4: 实现 ask() 函数——对话的核心循环
// 做这几件事：
//   a. rl.question 等用户输入
//   b. 用户消息 push 进 messages
//   c. 调 streamText，传 model、system prompt、messages
//   d. for await 消费 textStream，每个 chunk 写到终端
//   e. AI 回复 push 进 messages
//   f. 递归调 ask()
//
// 关键点：
//   - streamText({ model, messages }) 直接传 model 变量
//   - streamText 不用 await，它返回的不是 Promise
//   - 用 process.stdout.write 不是 console.log（不要自动换行）
const ask = () => {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      rl.close()
      return
    }


    messages.push({
      role: 'user',
      content: trimmed
    })

    const result = streamText({
      model,
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

    ask()
  })

}

// TODO 5: 打印欢迎信息，调 ask() 启动循环
console.log('Super Agent v0.1 (type "exit" to quit)\n')
ask()