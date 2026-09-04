import { type ModelMessage } from 'ai';
import { textToolResultOutput } from '../context/tool-result-output';


export function injectFakeHistory(messages: ModelMessage[]) {
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

/** Inject fake history with timestamps to demo TTL pruning. */
export function injectFakeHistory_lesson12(messages: ModelMessage[], timestamps: Map<number, number>) {
  const now = Date.now();
  const fakeHistory: Array<{ msg: ModelMessage; ageMs: number }> = [
    // 12 minutes ago — will be hard pruned
    { ageMs: 12 * 60 * 1000, msg: { role: 'user', content: '帮我看看 package.json' } },
    { ageMs: 12 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'old-1', toolName: 'read_file', input: { path: 'package.json' } }] } },
    { ageMs: 12 * 60 * 1000, msg: { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'old-1', toolName: 'read_file', output: textToolResultOutput('{\n  "name": "super-agent-09",\n  "version": "0.9.0",\n  "type": "module",\n  "scripts": { "start": "tsx src/index.ts" },\n  "dependencies": {\n    "ai": "5.0.98",\n    "@ai-sdk/openai": "2.0.44",\n    "zod": "3.25.76"\n  }\n}') }] } },
    { ageMs: 12 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'text' as const, text: 'package.json：项目名 super-agent-09，依赖 ai 和 @ai-sdk/openai。' }] } },

    // 7 minutes ago — will be soft pruned
    { ageMs: 7 * 60 * 1000, msg: { role: 'user', content: '搜索 src 目录里的 export' } },
    { ageMs: 7 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'mid-1', toolName: 'grep', input: { pattern: 'export', path: 'src' } }] } },
    { ageMs: 7 * 60 * 1000, msg: { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'mid-1', toolName: 'grep', output: textToolResultOutput('src/tools.ts:1: export const weatherTool = ...\nsrc/tools.ts:20: export const calculatorTool = ...\nsrc/tools.ts:40: export const readFileTool = ...\nsrc/tools.ts:60: export const writeFileTool = ...\nsrc/tools.ts:80: export const listDirectoryTool = ...\nsrc/tool-registry.ts:4: export interface ToolDefinition { ... }\nsrc/tool-registry.ts:18: export class ToolRegistry { ... }\nsrc/agent-loop.ts:7: export async function agentLoop(...) { ... }\nsrc/session-store.ts:8: export class SessionStore { ... }\nsrc/prompt-builder.ts:12: export class PromptBuilder { ... }\nsrc/context-defense.ts:5: export class TokenTracker { ... }\nsrc/context-defense.ts:50: export function estimateMessageTokens(...) { ... }\nsrc/context-defense.ts:70: export function truncateToolResults(...) { ... }\nsrc/context-defense.ts:110: export function ttlPrune(...) { ... }') }] } },
    { ageMs: 7 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'text' as const, text: 'src 目录里的主要导出：tools.ts 定义了各种工具，tool-registry.ts 导出 ToolRegistry 类，context-defense.ts 导出了 TokenTracker、truncateToolResults、ttlPrune 等。' }] } },

    // 1 minute ago — will NOT be pruned
    { ageMs: 1 * 60 * 1000, msg: { role: 'user', content: '读一下 sample-data.txt' } },
    { ageMs: 1 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'new-1', toolName: 'read_file', input: { path: 'sample-data.txt' } }] } },
    { ageMs: 1 * 60 * 1000, msg: { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'new-1', toolName: 'read_file', output: textToolResultOutput('Super Agent 工具系统设计文档\n=============================\n\n一、工具注册机制\n每个工具通过 ToolRegistry 统一注册。\n\n二、结果截断策略\nHead/Tail 60/40 分割。\n\n三、并发控制\n读写锁模式。\n\n四、最佳实践\n1. 工具描述要写"什么时候不该用"\n2. 参数描述要具体\n3. 错误信息要对模型友好\n4. 结果格式要结构化') }] } },
    { ageMs: 1 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'text' as const, text: 'sample-data.txt 是工具系统设计文档，包含注册机制、截断策略、并发控制和最佳实践四个部分。' }] } },
  ];

  for (let i = 0; i < fakeHistory.length; i++) {
    const { msg, ageMs } = fakeHistory[i];
    messages.push(msg);
    timestamps.set(messages.length - 1, now - ageMs);
  }
}