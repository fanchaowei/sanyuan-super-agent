import { streamText, type ModelMessage } from 'ai';
import { ToolRegistry } from '../tools/tool-registry.js';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { calculateDelay, isRetryable, sleep } from './retry.js';

const MAX_STEPS = 15;
const MAX_RETRIES = 3;

export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
) {
  let step = 0;
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: any;
    let stepUsage: any;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model, system, tools: registry.toAISDKFormat(), messages, maxRetries: 0,
          providerOptions: { openai: { parallelToolCalls: true } }, onError: () => { }
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              // 在真正记录本次调用前，先用历史窗口判断它是否会形成重复循环。
              // 这样 detect 看到的是“截至上一次调用”的状态，避免把当前调用提前算进去。
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
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
          }
        }

        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        // API 容错：只对可恢复错误重试，例如限流、超时、临时网络问题等。
        // 如果超过最大次数，或者错误本身不可重试，就把错误抛给上层处理。
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        // 使用退避延迟，避免失败后立即再次请求，给上游服务一点恢复时间。
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

    messages.push(...stepResponse.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮累计。
    // 不同 provider / SDK 版本返回的 usage 结构可能不同：
    // 有的直接是 number，有的是 { total }，所以这里做兼容读取。
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : (stepUsage?.inputTokens?.total ?? 0);
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : (stepUsage?.outputTokens?.total ?? 0);
    budget.used += inp + out;
    const pct = Math.round(budget.used / budget.limit * 100);
    console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`);
    if (budget.used > budget.limit) {
      // 超过预算后立刻停止，避免 agent 在长循环或异常重试中继续消耗额度。
      console.log('\n[Token 预算耗尽，强制停止]');
      break;
    }

    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log('  \u2192 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
