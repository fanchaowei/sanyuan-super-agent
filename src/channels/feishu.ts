import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

/**
 * 飞书通道的运行配置。
 *
 * 应用凭据用于创建飞书 API 客户端和 WebSocket 长连接；端口用于启动本地 Dashboard。
 */
interface FeishuConfig {
  /** 飞书开放平台应用的 App ID；为空时仅启动本地 Dashboard。 */
  appId: string;
  /** 飞书开放平台应用的 App Secret；为空时仅启动本地 Dashboard。 */
  appSecret: string;
  /** 本地 Dashboard 和模拟 Webhook HTTP 服务监听的端口。 */
  port: number;
}

/**
 * 基于飞书长连接模式实现的消息通道适配器。
 *
 * 启动时会始终创建本地 Dashboard，便于查看状态和模拟飞书消息；配置应用凭据后，还会
 * 动态加载飞书 SDK，创建消息 API 客户端，注册 `im.message.receive_v1` 事件，并建立 WebSocket
 * 长连接。收到的文本消息会移除机器人 mention，再转换为统一的 {@link IncomingMessage}
 * 交给网关；网关生成回复后，{@link send} 会按原 `chat_id` 调用飞书消息 API 发回文本。
 */
export class FeishuChannel implements ChannelDefinition {
  /** 通道的唯一名称，用于网关注册、会话隔离和日志标识。 */
  name = 'feishu';
  /** 通道用途和连接方式的可读说明。 */
  description = '飞书 Bot 消息通道（长连接模式）';

  /** 飞书应用凭据和本地 Dashboard 端口配置。 */
  private config: FeishuConfig;
  /** 网关注册的入站消息处理器；飞书事件和模拟事件最终都会交给它处理。 */
  private messageHandler?: (msg: IncomingMessage) => void;
  /** Dashboard 的 Node.js HTTP 服务实例；类型来自动态加载的 Hono Node Server。 */
  private httpServer?: any;
  /** 飞书 SDK 的 WebSocket 长连接客户端实例。 */
  private wsClient?: any;
  /** 飞书 SDK 的 REST API 客户端实例，用于发送回复消息。 */
  private larkClient?: any;

  /**
   * 创建飞书通道并保存运行配置。
   *
   * @param config 飞书应用凭据和本地 Dashboard 端口。
   */
  constructor(config: FeishuConfig) {
    this.config = config;
  }

  /**
   * 注册统一的入站消息处理器。
   *
   * 后续收到真实飞书消息或 Dashboard 模拟消息时，适配器都会调用该处理器，把标准消息
   * 交给 {@link ChannelGateway} 维护会话并运行 Agent。
   *
   * @param handler 每收到一条标准入站消息时调用的处理函数。
   */
  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 启动本地 Dashboard，并在凭据完整时建立飞书长连接。
   *
   * 方法首先启动 Dashboard，确保未配置飞书时仍可模拟完整通道流程；随后检查 App ID 和
   * App Secret。凭据有效时动态加载飞书 SDK，创建 REST 客户端和事件分发器，只接收文本
   * 消息并清除机器人 mention，最后启动 WebSocket 客户端等待飞书推送事件。
   */
  async start(): Promise<void> {
    // 启动状态面板（不管有没有配飞书都起）
    await this.startDashboard();

    if (!this.config.appId || !this.config.appSecret) {
      console.log('    飞书未配置 APP_ID / APP_SECRET，仅启动 Dashboard');
      console.log('    用页面上的「发送测试消息」或 curl 测试 Channel 流程');
      return;
    }

    // 用飞书 SDK 的长连接模式
    // lark 是动态加载的飞书 SDK 模块，只有配置凭据后才需要加载。
    const lark = await import('@larksuiteoapi/node-sdk');

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    // dispatcher 负责把 WebSocket 推送的飞书事件分派给对应事件处理函数。
    const dispatcher = new lark.EventDispatcher({});

    dispatcher.register({
      // data 是飞书 `im.message.receive_v1` 事件携带的消息和发送者数据。
      'im.message.receive_v1': (data) => {
        if (data.message.message_type !== 'text') return;

        // content 是从飞书消息 JSON 字符串中解析出的文本内容对象。
        const content = JSON.parse(data.message.content);
        // text 是准备交给 Agent 的纯文本，会在下方移除所有机器人 mention 标记。
        let text = content.text || '';
        // 去掉 @Bot 的 mention 标记
        if (data.message.mentions) {
          // m 是当前 mention 描述，key 对应飞书插入原文本中的占位标记。
          for (const m of data.message.mentions) {
            text = text.replace(m.key, '').trim();
          }
        }

        if (text && this.messageHandler) {
          this.messageHandler({
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || 'unknown',
            senderName: data.sender.sender_id?.open_id || 'unknown',
            text,
            raw: data,
          });
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('    飞书长连接已建立（无需 ngrok）');
  }

  /**
   * 停止当前适配器持有的本地 Dashboard HTTP 服务。
   *
   * 当前实现仅关闭 HTTP 服务；如果服务尚未创建则直接返回。WebSocket 客户端没有在此处
   * 显式停止，保留现有生命周期行为。
   */
  async stop(): Promise<void> {
    if (this.httpServer) this.httpServer.close();
  }

  /**
   * 通过飞书消息 API 向指定会话发送文本回复。
   *
   * 未配置飞书或 REST 客户端尚未创建时只记录日志并跳过；客户端可用时，以
   * `message.channelId` 作为飞书 `chat_id` 发送文本。API 异常会被转换为日志，不再向上抛出。
   *
   * @param message 网关生成的标准出站消息；当前实现使用其中的频道 ID 和文本。
   */
  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(`    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`);
      return;
    }

    try {
      await this.larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
        },
      });
    } catch (err) {
      // err 是飞书 API 抛出的未知错误值，可能是 Error 或其它可字符串化对象。
      // msg 将错误统一转换为适合日志输出的文本。
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    [feishu] 发送失败: ${msg}`);
    }
  }

  /**
   * 创建本地状态面板、模拟 Webhook 和健康检查服务。
   *
   * `/webhook/feishu` 接收与飞书事件近似的 JSON，把文本转换为统一入站消息；`/` 返回状态
   * 页面，并可在浏览器中构造模拟事件；`/health` 提供简单存活检查。所有路由注册完成后，
   * 方法使用配置端口启动 Node.js HTTP 服务，并保存服务实例供 {@link stop} 关闭。
   */
  private async startDashboard(): Promise<void> {
    // Hono 是动态加载的轻量 HTTP 应用构造器。
    const { Hono } = await import('hono');
    // serve 是动态加载的 Node.js HTTP 服务启动函数。
    const { serve } = await import('@hono/node-server');

    // app 是 Dashboard、模拟 Webhook 和健康检查共用的 Hono 应用实例。
    const app = new Hono();

    // 模拟 webhook（Dashboard 测试用）
    // c 是当前模拟 Webhook 请求对应的 Hono 上下文。
    app.post('/webhook/feishu', async (c) => {
      // body 是 Dashboard 或外部测试工具提交的模拟飞书事件对象。
      const body = await c.req.json();

      if (body.header?.event_type === 'im.message.receive_v1') {
        // event 是模拟请求中的飞书消息事件主体。
        const event = body.event;
        if (event.message?.message_type === 'text') {
          // content 是从模拟消息 JSON 字符串中解析出的文本内容对象。
          const content = JSON.parse(event.message.content);
          // text 是移除 Dashboard 模拟 mention 标记后准备交给 Agent 的文本。
          const text = content.text?.replace(/@_user_\d+/g, '').trim();
          if (text && this.messageHandler) {
            this.messageHandler({
              channelId: event.message.chat_id || 'web-test',
              senderId: event.sender?.sender_id?.open_id || 'web-dashboard',
              senderName: event.sender?.sender_id?.open_id || 'web-dashboard',
              text,
              raw: body,
            });
          }
        }
      }

      return c.json({ code: 0 });
    });

    // 状态面板
    // c 是当前 Dashboard 页面请求对应的 Hono 上下文。
    app.get('/', (c) => {
      // feishuStatus 是根据 App ID 推导出的飞书配置状态展示文本。
      const feishuStatus = this.config.appId ? '已连接（长连接模式）' : '未配置';
      // html 是返回给浏览器的完整 Dashboard 页面，其中包含状态卡片和模拟消息表单。
      const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>Super Agent — Channel Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; color: #38bdf8; margin-bottom: 0.75rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-ok { background: #065f46; color: #6ee7b7; }
    .badge-off { background: #78350f; color: #fcd34d; }
    .endpoint { font-family: monospace; background: #334155; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; }
    ul { list-style: none; }
    li { margin-bottom: 0.5rem; }
    textarea { width: 100%; background: #334155; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; resize: vertical; min-height: 60px; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; margin-top: 0.5rem; font-size: 0.9rem; }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 0.75rem; padding: 0.75rem; background: #334155; border-radius: 6px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; display: none; }
  </style>
</head>
<body>
  <h1>Super Agent v0.16</h1>
  <p class="subtitle">Channel Dashboard</p>

  <div class="card">
    <h2>Channel 状态</h2>
    <ul>
      <li><span class="badge ${this.config.appId ? 'badge-ok' : 'badge-off'}">${feishuStatus}</span> feishu — 飞书 Bot 消息通道</li>
    </ul>
  </div>

  <div class="card">
    <h2>发送测试消息</h2>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.75rem;">通过模拟 webhook 发消息给 Agent，回复在终端查看</p>
    <textarea id="msg" placeholder="输入要发给 Agent 的消息...">你好</textarea>
    <button onclick="sendTest()">发送</button>
    <div id="result"></div>
  </div>

  <script>
    // 从表单读取文本，构造模拟飞书事件并提交给本地 Webhook。
    async function sendTest() {
      // text 是用户在 Dashboard 文本框中输入并去除首尾空白后的测试消息。
      const text = document.getElementById('msg').value.trim();
      if (!text) return;
      // result 是用于展示模拟请求状态的页面元素。
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.textContent = '发送中...';
      try {
        // body 是结构与飞书消息事件近似的模拟 Webhook 请求体。
        const body = {
          header: { event_type: 'im.message.receive_v1' },
          event: {
            message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'web-test' },
            sender: { sender_id: { open_id: 'web-dashboard' } }
          }
        };
        // res 是本地模拟 Webhook 返回的 HTTP 响应。
        const res = await fetch('/webhook/feishu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        // data 是 Webhook 响应解析后的 JSON；完成解析也用于确认响应体格式有效。
        const data = await res.json();
        result.textContent = 'OK — 查看终端输出';
      } catch (e) {
        // e 是请求发送或响应解析期间抛出的错误。
        result.textContent = e.message;
      }
    }
  </script>
</body>
</html>`;
      return c.html(html);
    });

    // c 是当前健康检查请求的 Hono 上下文，响应固定的存活状态文本。
    app.get('/health', (c) => c.text('OK'));

    // httpServer 保存实际监听端口的 Node.js 服务实例，供 stop() 关闭。
    this.httpServer = serve({ fetch: app.fetch, port: this.config.port });
    console.log(`    Dashboard: http://localhost:${this.config.port}`);
  }
}
