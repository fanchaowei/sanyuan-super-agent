/**
 * Hook 执行结果的动作类型。
 *
 * Hook 可以允许工具继续执行、拦截工具调用，或者先修改输入/输出再继续处理。
 */
export type HookAction = 'allow' | 'block' | 'modify';

/**
 * 单个 Hook 的统一返回结构。
 *
 * `action` 用于告诉管道下一步应该怎么做；`reason` 用于记录拦截原因；
 * `modifiedInput` 和 `modifiedOutput` 分别承载 Hook 修改后的输入和输出。
 */
export interface HookResult {
  /** Hook 希望管道采取的动作。 */
  action: HookAction;
  /** 当 Hook 拦截请求或需要补充说明时使用的原因。 */
  reason?: string;
  /** pre Hook 修改后的工具输入。 */
  modifiedInput?: unknown;
  /** post Hook 修改后的工具输出。 */
  modifiedOutput?: unknown;
}

/** 工具执行前调用的 Hook，接收工具名称和当前输入。 */
export type PreToolHook = (toolName: string, input: unknown) => HookResult | Promise<HookResult>;
/** 工具执行后调用的 Hook，接收工具名称、输入和当前输出。 */
export type PostToolHook = (toolName: string, input: unknown, output: unknown) => HookResult | Promise<HookResult>;

/**
 * Hook 管道。
 *
 * 管道按照注册顺序执行 pre Hook 和 post Hook：pre Hook 可以拦截或修改输入，
 * post Hook 可以在工具执行完成后继续修改输出。单个 Hook 出错时会记录日志，
 * 不会阻止其他 Hook 继续执行。
 */
export class HookPipeline {
  /** 按注册顺序保存所有工具执行前的 Hook。 */
  private preHooks: Array<{ name: string; fn: PreToolHook }> = [];
  /** 按注册顺序保存所有工具执行后的 Hook。 */
  private postHooks: Array<{ name: string; fn: PostToolHook }> = [];

  /** 注册一个工具执行前的 Hook。 */
  registerPre(name: string, fn: PreToolHook): void {
    /** Hook 的名称和执行函数会一起保存，便于执行时记录日志。 */
    this.preHooks.push({ name, fn });
  }

  /** 注册一个工具执行后的 Hook。 */
  registerPost(name: string, fn: PostToolHook): void {
    /** Hook 的名称和执行函数会一起保存，便于执行时记录日志。 */
    this.postHooks.push({ name, fn });
  }

  /**
   * 按顺序执行所有 pre Hook。
   *
   * 每个 Hook 都会读取上一个 Hook 产生的输入；一旦收到 `block` 就立即返回，
   * 收到带有修改值的 `modify` 则把新输入传给后续 Hook。
   */
  async runPre(toolName: string, input: unknown): Promise<HookResult> {
    /** 当前正在管道中传递的输入，初始值来自工具调用方。 */
    let currentInput = input;

    /** 逐个执行已注册的 pre Hook，并保持注册顺序。 */
    for (const hook of this.preHooks) {
      try {
        /** 当前 Hook 对工具输入做出的决策。 */
        const result = await hook.fn(toolName, currentInput);
        if (result.action === 'block') {
          console.log(`  [hook:${hook.name}] 拦截 ${toolName}: ${result.reason}`);
          return result;
        }
        if (result.action === 'modify' && result.modifiedInput !== undefined) {
          // 将本次 hooks 处理后的 input 输入作为 currentInput ，提供给下一个循环使用
          currentInput = result.modifiedInput;
          console.log(`  [hook:${hook.name}] 修改了 ${toolName} 的输入`);
        }
      } catch (err) {
        /** 将未知异常统一转换为可打印的错误消息。 */
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [hook:${hook.name}] pre 异常: ${msg}`);
      }
    }

    return { action: 'allow' };
  }

  /**
   * 按顺序执行所有 post Hook。
   *
   * post Hook 不会拦截已经完成的工具调用，只会根据返回结果逐步修改输出，
   * 最终将最新输出放入 `modifiedOutput` 返回给调用方。
   */
  async runPost(toolName: string, input: unknown, output: unknown): Promise<HookResult> {
    /** 当前正在管道中传递的输出，初始值来自工具执行结果。 */
    let currentOutput = output;

    /** 逐个执行已注册的 post Hook，并保持注册顺序。 */
    for (const hook of this.postHooks) {
      try {
        /** 当前 Hook 对工具输出做出的决策。 */
        const result = await hook.fn(toolName, input, currentOutput);
        if (result.action === 'modify' && result.modifiedOutput !== undefined) {
          currentOutput = result.modifiedOutput;
          console.log(`  [hook:${hook.name}] 修改了 ${toolName} 的输出`);
        }
      } catch (err) {
        /** 将未知异常统一转换为可打印的错误消息。 */
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [hook:${hook.name}] post 异常: ${msg}`);
      }
    }

    return { action: 'allow', modifiedOutput: currentOutput };
  }

  /**
   * 返回当前已注册的 Hook 名称，便于调试、展示或检查管道配置。
   */
  list(): { pre: string[]; post: string[] } {
    /** 只返回名称，不暴露 Hook 的具体实现函数。 */
    return {
      /** 所有 pre Hook 的名称列表。 */
      pre: this.preHooks.map(h => h.name),
      /** 所有 post Hook 的名称列表。 */
      post: this.postHooks.map(h => h.name),
    };
  }
}
