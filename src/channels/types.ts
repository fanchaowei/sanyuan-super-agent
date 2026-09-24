/**
 * 通道层的公共类型定义。
 *
 * 各通道适配器负责把平台原始事件转换为 {@link IncomingMessage} 交给网关，网关完成 Agent
 * 处理后再构造 {@link OutgoingMessage}，通过 {@link ChannelDefinition.send} 发回对应平台。
 */

/**
 * 通道适配器标准化后的入站消息。
 *
 * 不同平台的事件结构各不相同，适配器只需把会话定位、发送者身份和文本内容映射到这些
 * 公共字段；确实需要平台专属信息时，仍可从 {@link raw} 中读取原始事件。
 */
export interface IncomingMessage {
  /** 消息所在的频道、群组或会话 ID，用于把回复发送回原会话。 */
  channelId: string;
  /** 消息发送者的稳定唯一 ID，用于识别用户并隔离会话历史。 */
  senderId: string;
  /** 消息发送者的可读名称，主要用于日志和界面展示。 */
  senderName: string;
  /** 已从平台事件中提取的纯文本消息内容。 */
  text: string;
  /** 平台提供的原始事件对象；仅在公共字段不足以满足处理需求时使用。 */
  raw?: unknown;
}

/**
 * 网关交给通道适配器发送的标准出站消息。
 *
 * 该结构描述“向哪个会话中的哪个接收者发送什么文本”，具体的平台 API 调用、鉴权和
 * 消息格式转换由各个 {@link ChannelDefinition} 实现负责。
 */
export interface OutgoingMessage {
  /** 目标频道、群组或会话 ID。 */
  channelId: string;
  /** 目标接收者 ID，通常对应触发入站消息的发送者。 */
  recipientId: string;
  /** 准备发送给接收者的纯文本内容。 */
  text: string;
}

/**
 * 网关可管理的通道适配器契约。
 *
 * 一个通道实现负责完成自身生命周期管理、出站消息发送，以及把平台入站事件转换为
 * {@link IncomingMessage} 后交给已注册的处理器。网关只依赖这组统一接口，因此无需了解
 * Telegram、Discord 或其它具体平台的连接与协议细节。
 */
export interface ChannelDefinition {
  /** 通道的唯一名称，用作注册表键、会话键前缀和日志标识。 */
  name: string;
  /** 通道用途的可读说明，用于命令输出或状态展示。 */
  description: string;

  /**
   * 启动通道并建立接收消息所需的连接或监听器。
   *
   * 简单实现可以同步完成；涉及网络连接的实现可以返回 Promise，由网关等待启动结束。
   */
  start(): Promise<void> | void;
  /**
   * 停止通道并释放连接、监听器等资源。
   *
   * 简单实现可以同步完成；异步清理可以返回 Promise，由网关等待清理结束。
   */
  stop(): Promise<void> | void;
  /**
   * 把标准出站消息转换为平台请求并发送。
   *
   * @param message 包含目标会话、接收者和回复文本的出站消息。
   * @returns 消息发送完成时兑现的 Promise；发送失败时应拒绝该 Promise。
   */
  send(message: OutgoingMessage): Promise<void>;

  /**
   * 注册入站消息处理器。
   *
   * 支持接收入站事件的通道在平台消息到达后，应先构造 {@link IncomingMessage}，再调用
   * handler 将消息交给网关。该方法为可选项，以兼容只具备发送能力的通道。
   *
   * @param handler 每收到一条标准入站消息时调用的处理函数。
   */
  onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}
