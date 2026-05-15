import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import 'dotenv/config'
import { createMockModel } from './mock-model'

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model: any = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel()

async function main() {
  // 流式输出
  const result = await streamText({
    model,
    prompt: '用一句话介绍你自己',
  })

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk)
  }

  console.log() // 换行
}

main()
