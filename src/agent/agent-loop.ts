import { streamText, type ModelMessage } from 'ai';
import { TokenTracker } from '../context/defense.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { calculateDelay, isRetryable, sleep } from './retry.js';

// 单次任务最多允许模型进行 15 轮“思考/调用工具”，防止异常情况下无限循环。
const MAX_STEPS = 15;
// 网络或上游服务暂时失败时，最多额外重试 3 次。
const MAX_RETRIES = 3;
const TOKEN_BUDGET = 50000;

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker: TokenTracker
) {
  let step = 0;
  let totalTokens = 0;
  // 循环检测历史属于本次 agent 运行的状态；每次新任务开始前必须清空。
  resetHistory();

  // 每一轮都会把上一轮的响应追加到 messages，再交给模型决定下一步动作。
  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    // 标记本轮响应是否请求过工具；没有工具调用意味着模型通常已经给出最终答案。
    let hasToolCall = false;
    // 汇总本轮流式返回的所有文本增量，用于输出收尾和判断是否产生了文本答案。
    let fullText = '';
    // 循环检测达到 critical 级别时置为 true，在本轮流结束后统一退出外层循环。
    let shouldBreak = false;
    // 暂存最近一次工具调用，使随后到达的工具结果能与调用名称及参数配对。
    let lastToolCall: { name: string; input: unknown } | null = null;
    // 保存本轮 SDK 标准化响应，流消费完成后会把其中的消息加入会话历史。
    let stepResponse: any;
    // 保存本轮 token 用量；不同 provider 可能返回数字或带 total 字段的对象。
    let stepUsage: any;

    // attempt 表示当前模型请求的尝试次数；成功后 break，失败时按策略重试。
    for (let attempt = 1; ; attempt++) {
      try {
        // 发起一次流式模型请求：同时提供系统提示、历史消息和可用工具。
        // 关闭 SDK 内置重试，统一由下面的 catch 按项目策略处理重试和退避。
        // result 同时提供实时事件流，以及流结束后可读取的完整响应和用量统计。
        const result = streamText({
          model, system, tools: registry.toAISDKFormat(), messages, maxRetries: 0,
          // 允许模型在同一响应中并行提出多个工具调用（由 SDK/provider 执行）。
          providerOptions: { openai: { parallelToolCalls: true } }, onError: () => { }
        });

        // fullStream 按事件顺序产出文本、工具调用和工具结果，适合边生成边处理。
        // part 是当前到达的流事件，可能是文本增量、工具调用或工具执行结果。
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              // 文本增量立即输出给用户，同时拼起来用于判断本轮是否有最终答复。
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              // 在真正记录本次调用前，先用历史窗口判断它是否会形成重复循环。
              // 这样 detect 看到的是“截至上一次调用”的状态，避免把当前调用提前算进去。
              // detection 描述本次调用是否与历史调用形成重复循环及其严重程度。
              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  // critical 表示已经达到熔断条件：停止当前 agent loop，避免继续烧 token。
                  shouldBreak = true;
                } else {
                  // warning 不直接停止，而是把系统提醒塞回 messages。
                  // 下一步模型能看到这条提醒，从而有机会换工具、换参数或直接回答。
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              // 检测完成后再记录当前调用，供后续 tool-result 和下一轮 detect 使用。
              recordCall(part.toolName, part.input);
              break;
            }

            case 'tool-result':
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                // 将工具结果和对应调用配对记录，供后续循环检测判断是否反复失败。
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
          }
        }

        // response 提供可追加到下一轮上下文的标准消息；usage 用于扣减 token 预算。
        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        // API 容错：只对可恢复错误重试，例如限流、超时、临时网络问题等。
        // 如果超过最大次数，或者错误本身不可重试，就把错误抛给上层处理。
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        // 使用退避延迟，避免失败后立即再次请求，给上游服务一点恢复时间。
        // delay 是根据尝试次数计算出的退避等待时间，单位为毫秒。
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`);
        // sleep 只暂停当前重试流程，不会阻塞 Node.js 处理其它异步任务。
        await sleep(delay);
        // 本次 attempt 的流式状态不能带到下一次请求里，否则会误判工具调用和输出。
        hasToolCall = false; fullText = ''; shouldBreak = false; lastToolCall = null;
      }
    }

    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    // Token 预算追踪：tracker 由调用方持有，跨轮累计。
    // 不同 provider / SDK 版本返回的 usage 结构可能不同：
    // 有的直接是 number，有的是 { total }，所以这里做兼容读取。
    // inp、out 分别是本轮输入和输出 token 数；兼容数值及 { total } 两种结构。
    // usage 缺失或结构不符合预期时按 0 处理，避免预算计算出现 NaN。
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : (stepUsage?.inputTokens?.total ?? 0);
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : (stepUsage?.outputTokens?.total ?? 0);

    // 输入 token 是服务端针对完整 prompt 的精确统计，用它重新校准 tracker 的估算基线。
    if (inp > 0) tracker.updateFromAPI(inp);

    // responseMessages 包含本轮产生的 assistant 消息和工具相关消息。
    const responseMessages = stepResponse!.messages as ModelMessage[];
    // 保存本轮 assistant/tool 消息，下一轮模型才能看到刚才的输出和工具结果。
    messages.push(...responseMessages);
    // tracker 记录新增消息的字符增量，用于下一次服务端精确统计返回前估算 token。
    tracker.addMessages(responseMessages);

    // 累加每轮实际输入与输出 token，用于控制整个任务的总预算，而非单轮预算。
    totalTokens += inp + out;
    // 超过 90% 时只输出预警，不会立即停止循环。
    if (totalTokens > TOKEN_BUDGET * 0.9) {
      console.log(`  [Token] ${totalTokens}/${TOKEN_BUDGET} (${Math.round(totalTokens / TOKEN_BUDGET * 100)}%)`);
    }
    // 真正超过预算后终止循环，避免后续模型调用继续消耗 token。
    if (totalTokens > TOKEN_BUDGET) {
      console.log('\n[Token 预算耗尽]');
      break;
    }

    if (!hasToolCall) {
      // 模型没有请求工具，说明它已经给出最终文本答案，本次 agent loop 可以结束。
      if (fullText) console.log();
      break;
    }

    // 仍有工具调用，继续下一轮，让模型根据工具结果决定后续动作。
    console.log('  \u2192 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
