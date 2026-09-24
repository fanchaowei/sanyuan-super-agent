import type { ModelMessage } from 'ai';
import { agentLoop } from '../agent/agent-loop.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

/**
 * 创建 {@link ChannelGateway} 所需的依赖。
 *
 * 网关本身不负责创建模型、注册工具或拼装系统提示词，而是通过该配置接收这些能力，
 * 从而只关注通道生命周期、会话隔离和消息转发。
 */
interface GatewayOptions {
  /** Agent 循环使用的模型实例；具体类型由 AI SDK 的模型提供方决定。 */
  model: any;
  /** Agent 可调用的工具注册表。 */
  registry: ToolRegistry;
  /** 为每次收到的消息构建最新系统提示词的工厂函数。 */
  buildSystem: () => string;
}

/** 对外展示的通道基本信息，不暴露通道实例及其操作能力。 */
interface ChannelSummary {
  /** 通道的唯一名称。 */
  name: string;
  /** 通道用途的可读说明。 */
  description: string;
}

/**
 * 统一管理消息通道，并在外部通道和 Agent 执行循环之间转发消息。
 *
 * 整体流程如下：
 * 1. 通过 {@link register} 保存通道，并把通道的入站消息事件绑定到网关。
 * 2. 通过 {@link startAll} 启动全部通道，等待各通道接收外部消息。
 * 3. 收到消息后，以“通道名称 + 发送者 ID”隔离会话历史，再调用 Agent 循环。
 * 4. Agent 执行结束后，从最新的 assistant 消息中提取文本，并通过原通道回复发送者。
 * 5. 应用退出时通过 {@link stopAll} 依次释放各通道资源。
 */
export class ChannelGateway {
  /** 已注册通道表；键是通道名称，值是对应的通道实现。 */
  private channels = new Map<string, ChannelDefinition>();
  /** 会话历史表；键由通道名称和发送者 ID 组成，值是该会话的模型消息历史。 */
  private sessions = new Map<string, ModelMessage[]>();
  /** 网关运行所依赖的模型、工具注册表和系统提示词构建函数。 */
  private options: GatewayOptions;

  /**
   * 创建通道网关并保存运行依赖。
   *
   * @param options 模型调用、工具访问和系统提示词构建所需的配置。
   */
  constructor(options: GatewayOptions) {
    this.options = options;
  }

  /**
   * 注册一个通道，并把它的入站消息回调接入网关处理流程。
   *
   * 同名通道会覆盖通道表中的旧实例；如果通道支持消息订阅，收到的每条消息都会携带
   * 当前通道名称交给 {@link handleIncoming}，用于定位会话和回发通道。
   *
   * @param channel 待注册的通道实现。
   */
  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);

    // msg 是通道适配器收到并标准化后的单条入站消息。
    channel.onMessage?.((msg: IncomingMessage) => {
      this.handleIncoming(channel.name, msg);
    });
  }

  /**
   * 逐个启动所有已注册通道。
   *
   * 单个通道启动失败时会记录错误并继续启动其余通道，避免一个适配器故障阻断整个网关。
   */
  async startAll(): Promise<void> {
    // name 用于日志标识，ch 是当前准备启动的通道实例。
    for (const [name, ch] of this.channels) {
      try {
        await ch.start();
        console.log(`  [gateway] ✓ ${name} 已启动`);
      } catch (err) {
        // err 是通道 start 抛出的未知错误值，既可能是 Error，也可能是其它可字符串化的值。
        // msg 将任意捕获值规范化为适合输出的错误文本。
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`);
      }
    }
  }

  /**
   * 逐个停止所有已注册通道并等待资源释放完成。
   *
   * 停止异常会直接向调用方抛出，因此调用方可以感知清理失败并决定如何处理。
   */
  async stopAll(): Promise<void> {
    // ch 是当前准备停止的通道实例；通道名称在停止流程中不需要使用。
    for (const [, ch] of this.channels) {
      await ch.stop();
    }
  }

  /**
   * 处理一条入站消息，维护独立会话，运行 Agent，并把最终文本回复到原通道。
   *
   * 方法先用通道名称和发送者 ID 定位会话，将本次用户消息追加到历史；随后动态构建系统
   * 提示词并调用 {@link agentLoop}。Agent 会把执行结果继续写入同一消息数组，因此循环结束后
   * 只需读取最后一条 assistant 消息，兼容纯字符串和文本分片两种内容格式，再发送回复。
   *
   * @param channelName 收到消息的通道名称，用于隔离会话和查找回发通道。
   * @param msg 通道适配器标准化后的入站消息。
   */
  private async handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    // sessionKey 隔离不同通道、不同发送者的上下文，避免会话历史相互污染。
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    // messages 是当前发送者在当前通道中的可变模型消息历史，agentLoop 会继续向其中追加结果。
    const messages = this.sessions.get(sessionKey)!;

    // userMsg 将通道文本转换为 AI SDK 接受的用户消息格式。
    const userMsg: ModelMessage = { role: 'user', content: msg.text };
    messages.push(userMsg);

    // system 是针对本次 Agent 执行即时生成的系统提示词。
    const system = this.options.buildSystem();
    // beforeLen 记录调用 Agent 前的消息数量；当前实现尚未消费该快照，保留现有变量不改变逻辑。
    const beforeLen = messages.length;

    await agentLoop(
      this.options.model,
      this.options.registry,
      messages,
      system,
    );

    // lastMsg 是 Agent 执行后会话中的最后一条消息，预期为可回复的 assistant 消息。
    const lastMsg = messages[messages.length - 1];
    // replyText 保存从 assistant 消息中提取并准备发送给通道的纯文本。
    let replyText = '';
    if (lastMsg && lastMsg.role === 'assistant') {
      // content 可能是纯字符串，也可能是 AI SDK 返回的结构化内容分片数组。
      const content = lastMsg.content;
      if (typeof content === 'string') {
        replyText = content;
      } else if (Array.isArray(content)) {
        replyText = content
          // c 是当前结构化内容分片；这里只保留能够直接回复用户的文本分片。
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
      }
    }

    if (replyText) {
      // channel 是原始入站通道；通道可能已被移除，因此发送前再次确认其存在。
      const channel = this.channels.get(channelName);
      if (channel) {
        // outgoing 把 Agent 文本封装成通道统一的出站消息格式，并回复给原发送者。
        const outgoing: OutgoingMessage = {
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        };
        await channel.send(outgoing);
        console.log(`  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`);
      }
    }
  }

  /**
   * 列出所有已注册通道的公开元数据。
   *
   * 返回值是新数组，且只包含名称和描述，调用方无法借此修改网关内部的通道表。
   *
   * @returns 已注册通道的名称和描述列表。
   */
  list(): ChannelSummary[] {
    // ch 是当前通道实例，映射结果仅保留适合对外展示的元数据。
    return Array.from(this.channels.values()).map(ch => ({
      name: ch.name,
      description: ch.description,
    }));
  }
}
