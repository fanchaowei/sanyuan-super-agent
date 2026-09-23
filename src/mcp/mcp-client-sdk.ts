/**
 * Client 是 MCP 协议的总管家，负责握手、发现工具、调用工具这些高层操作。你告诉它“列出所有工具”，它就知道要发 tools/list 这个消息给 Server。
 * StdioClientTransport 是具体的通信方式——通过标准输入输出（stdin/stdout）来收发消息。它背后干了我们手写代码里那些事：启动子进程、逐行读 stdout、按 id 匹配响应。Client 不关心底层怎么传消息，只要有个 Transport 给它用就行。
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/**
 * 官方 SDK 版本的 MCP client。
 *
 * 对照原来的 mcp-client.ts：
 * - 原版自己 spawn 子进程、readline 读 stdout、手写 JSON-RPC、维护 pending Map。
 * - 这个版本把这些底层工作交给 Client + StdioClientTransport。
 * - 对外仍保留 connect/listTools/callTool/close，方便 ToolRegistry 几乎无感替换。
 */
interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPTextContent {
  type: string;
  text?: string;
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export class MCPClient {
  /**
   * 区别 1：
   * 原版保存 ChildProcess、readline、requestId、pending Map。
   * SDK 版只需要保存官方 Client 和 Transport。
   */
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) { }

  async connect(): Promise<void> {
    /**
     * 区别 2：
     * 原版这里直接 spawn(command, args)，然后自己监听 stdout/stderr。
     * SDK 版创建 StdioClientTransport，它内部负责启动子进程和按 MCP stdio 协议收发消息。
     *
     * 注意：
     * 教程里 env 只写了 { GITHUB_PERSONAL_ACCESS_TOKEN: token }。
     * 这里合并 process.env 是为了保留 PATH，否则 npx 可能找不到。
     */
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...toStringEnv(process.env), ...this.env },
    });

    /**
     * 区别 3：
     * 原版自己发送 initialize JSON-RPC，再发送 notifications/initialized。
     * SDK 版 client.connect(transport) 会完成这套 MCP 初始化握手。
     */
    this.client = new Client({ name: 'super-agent', version: '1.0.0' });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.client) throw new Error('MCP client not connected');

    /**
     * 区别 4：
     * 原版调用 send('tools/list', {})，自己等待 id 匹配的响应。
     * SDK 版直接调用 client.listTools()。
     */
    const result = await this.client.listTools();

    return result.tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.client) throw new Error('MCP client not connected');

    /**
     * 区别 5：
     * 原版调用 send('tools/call', { name, arguments: args })。
     * SDK 版直接调用 client.callTool(...)，参数形状和 MCP 协议保持一致。
     */
    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    /**
     * 区别 6：
     * 原版和 SDK 版都需要把 MCP content 里的 text 拼成字符串。
     * 因为 ToolRegistry / LLM 上层现在消费的是字符串结果。
     */
    const texts = ((result.content || []) as MCPTextContent[])
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!);

    return texts.join('\n') || '(无返回内容)';
  }

  async close(): Promise<void> {
    /**
     * 区别 7：
     * 原版自己 close readline、kill 子进程。
     * SDK 版关闭 client 即可释放底层 transport。
     */
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }
}

/**
 * MockMCPClient 保持原样。
 *
 * 学习重点：
 * ToolRegistry 并不关心真实 client 是手写 JSON-RPC，还是官方 SDK。
 * 只要对象实现 connect/listTools/callTool/close 这组方法，就能被注册进去。
 */
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
    name: string,
    args: Record<string, unknown>,
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
