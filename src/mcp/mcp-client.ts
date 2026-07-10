import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

/**
 * 一个极简 MCP 客户端实现。
 *
 * 业务流程可以理解为：
 * 1. 启动一个 MCP server 子进程。
 * 2. 通过子进程的 stdin/stdout 按行收发 JSON-RPC 消息。
 * 3. 初始化握手完成后，查询 server 暴露了哪些 tools。
 * 4. 调用具体 tool，并把 MCP 返回的 text content 合并成普通字符串。
 */
interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// MCP tools/call 的返回结构。这里只关心 text 类型的内容，其它类型暂时忽略。
interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class MCPClient {
  // MCP server 被作为本地子进程启动，stdio 就是客户端和 server 的通信通道。
  private process: ChildProcess | null = null;

  // readline 把 stdout 拆成一行一行的 JSON-RPC 消息，避免手动处理流分包。
  private rl: Interface | null = null;

  // 每发出一个 JSON-RPC request 都递增 id，用它把响应匹配回原来的 Promise。
  private requestId = 0;

  /**
   * pending 保存“已发送但还没收到响应”的请求。
   *
   * key 是 JSON-RPC id；value 是该请求对应 Promise 的 resolve/reject。
   * 当 stdout 收到同 id 的响应时，就能找到这里的回调并结束等待。
   */
  private pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
  }>();

  // 从包名/参数里推导出来的服务名，方便后续日志或展示时识别不同 MCP server。
  private serverName: string;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    this.serverName = args[args.length - 1]?.replace(/^@.*\//, '')
      || 'mcp-server';
  }

  async connect(): Promise<void> {
    // 启动 MCP server。MCP stdio transport 要求 stdin/stdout 可读写，所以这里都使用 pipe。
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });

    this.process.on('error', (err) => {
      console.error(`  [MCP] 进程启动失败: ${err.message}`);
    });
    this.process.stderr?.on('data', () => { });

    // MCP server 的每一条 JSON-RPC 消息以换行结尾，这里按行读取 stdout。
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);

        // 这里只处理“带 id 的响应”。没有 id 的通知类消息不需要 resolve 某个请求。
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(
              `MCP error ${msg.error.code}: ${msg.error.message}`
            ));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch { /* ignore non-JSON lines */ }
    });

    // MCP 初始化握手：告诉 server 当前客户端支持的协议版本、能力和客户端信息。
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'super-agent', version: '0.5.0' },
    });

    // 初始化 request 成功后，按协议再发送 initialized 通知，表示客户端已准备好。
    // 通知没有 id，也不需要等待响应，所以这里直接写入 stdin，不走 send()。
    this.process.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');
  }

  /**
   * 发送一条 JSON-RPC request。
   *
   * 核心思想是“先登记 pending，再写入 stdin”：
   * server 响应回来时，stdout 监听器会通过 id 找到 pending 中的 Promise 并完成它。
   */
  private send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;

      // 防止 MCP server 无响应时调用方一直挂起。
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 15000);

      this.pending.set(id, {
        resolve: (v: any) => { clearTimeout(timeout); resolve(v); },
        reject: (e: Error) => { clearTimeout(timeout); reject(e); },
      });

      // stdio transport 使用一行一个 JSON-RPC 对象，所以末尾必须带换行。
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process!.stdin!.write(msg + '\n');
    });
  }

  // 向 MCP server 查询它暴露的工具清单，后续可以注册到本项目的工具系统中。
  async listTools(): Promise<MCPTool[]> {
    const result = await this.send('tools/list', {});
    return result.tools || [];
  }

  // 调用 MCP server 中的某个工具，并把 text content 合并成方便 LLM/上层代码消费的字符串。
  async callTool(
    name: string, args: Record<string, unknown>
  ): Promise<string> {
    const result: MCPCallResult = await this.send(
      'tools/call', { name, arguments: args }
    );

    // MCP content 可能包含 text、image、resource 等类型；当前简易客户端只抽取文本。
    const texts = (result.content || [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!);
    return texts.join('\n') || '(无返回内容)';
  }

  async close(): Promise<void> {
    // 释放 readline 和子进程，避免 CLI 退出时仍有后台 MCP server 挂着。
    if (this.rl) this.rl.close();
    if (this.process) this.process.kill();
  }
}

export class MockMCPClient {
  async connect(): Promise<void> { }

  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: 'list_issues',
        description: '列出 GitHub 仓库的 Issues',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '仓库所有者' },
            repo: { type: 'string', description: '仓库名称' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'search_repositories',
        description: '搜索 GitHub 仓库',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_file_contents',
        description: '获取仓库中文件的内容',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '仓库所有者' },
            repo: { type: 'string', description: '仓库名称' },
            path: { type: 'string', description: '文件路径' },
          },
          required: ['owner', 'repo', 'path'],
        },
      },
    ];
  }

  async callTool(
    name: string, args: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case 'list_issues':
        return JSON.stringify([
          { number: 42, title: '支持 MCP 协议接入', state: 'open' },
          { number: 41, title: '循环检测阈值可配置化', state: 'open' },
          { number: 39, title: 'Token 预算用完后的优雅降级', state: 'closed' },
        ], null, 2);
      case 'search_repositories':
        return JSON.stringify([
          { full_name: 'anthropics/anthropic-sdk-python', stars: 2800 },
          { full_name: 'vercel/ai', stars: 12000 },
          { full_name: 'modelcontextprotocol/servers', stars: 5600 },
        ], null, 2);
      case 'get_file_contents':
        return `# README\n\nMock file: ${args.owner}/${args.repo}/${args.path}`;
      default:
        return `未知工具: ${name}`;
    }
  }

  async close(): Promise<void> { }
}

