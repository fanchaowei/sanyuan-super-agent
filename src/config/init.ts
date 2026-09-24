import fs from "node:fs";
import { createInterface } from "node:readline";
import { CONFIG_FILE } from "./loader.js";

/**
 * 运行 SuperAgent 初始化向导 (CLI Init Wizard)
 *
 * 【作用】
 * 通过命令行交互方式引导用户生成 `super-agent.config.json` 配置文件及 `.env` 环境变量文件。
 * 支持配置模型选择、API 密钥、飞书机器人渠道参数、子 Agent 并发限制等核心项。
 *
 * 【具体执行流程】
 * 1. 创建 Node.js readline 命令行输入输出接口。
 * 2. 检查当前目录下是否已存在 `super-agent.config.json`，若存在则询问用户是否覆盖。
 * 3. 提示并接收用户选择的模型（qwen-plus-latest、qwen-turbo-latest、qwen-max-latest）。
 * 4. 提示并接收 DashScope API Key（可选，留空则默认运行时从环境变量加载）。
 * 5. 询问是否启用飞书 Channel，若启用则提示输入飞书 App ID 和 App Secret。
 * 6. 提示输入子 Agent 最大并发数（默认 3）。
 * 7. 组装结构化配置对象，序列化后写入 `super-agent.config.json` 文件。
 * 8. 若输入了 API Key 或飞书凭证，则同时生成或追加到 `.env` 文件中。
 * 9. 关闭 readline 交互流，提示后续启动命令。
 */
export async function runInit(): Promise<void> {
  // 创建 readline 交互接口实例
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /**
   * 封装 readline 提问函数为 Promise，简化异步交互逻辑
   * @param q 提示问题文本
   * @returns 用户输入的文本字符串
   */
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      console.log(q);
      rl.question("  > ", resolve);
    });

  console.log("\n  Super Agent 初始化向导\n");

  // 1. 检查配置文件是否已存在
  if (fs.existsSync(CONFIG_FILE)) {
    const overwrite = await ask(`  ${CONFIG_FILE} 已存在，覆盖? (y/N): `);
    if (overwrite.toLowerCase() !== "y") {
      console.log("  已取消\n");
      rl.close();
      return;
    }
  }

  // 2. 选择模型
  console.log("  选择模型:\n");
  console.log("    1. qwen-plus-latest   (推荐，均衡)");
  console.log("    2. qwen-turbo-latest  (快速，便宜)");
  console.log("    3. qwen-max-latest    (最强，贵)\n");
  const modelChoice = (await ask("  模型 [1]: ")) || "1";
  const models: Record<string, string> = {
    "1": "qwen-plus-latest",
    "2": "qwen-turbo-latest",
    "3": "qwen-max-latest",
  };
  const modelName = models[modelChoice] || "qwen-plus-latest";

  // 3. 配置 API Key
  const apiKey = await ask("\n  DashScope API Key (留空则从环境变量 DASHSCOPE_API_KEY 读取): ");

  // 4. 配置飞书渠道
  const enableFeishu = (await ask("\n  启用飞书 Channel? (y/N): ")).toLowerCase() === "y";
  let feishuAppId = "";
  let feishuAppSecret = "";
  if (enableFeishu) {
    feishuAppId = await ask("  飞书 App ID: ");
    feishuAppSecret = await ask("  飞书 App Secret: ");
  }

  // 5. 配置子 Agent 并发数
  const concurrentStr = await ask("\n  子 Agent 最大并发数 [3]: ");
  const maxConcurrent = parseInt(concurrentStr) || 3;

  // 6. 组装初始配置对象
  const config = {
    version: "1.0",
    model: {
      provider: "dashscope",
      name: modelName,
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: apiKey || "${DASHSCOPE_API_KEY}",
    },
    plugins: [{ name: "supabase", enabled: false, config: {} }],
    channels: {
      feishu: {
        enabled: enableFeishu,
        appId: enableFeishu ? feishuAppId : "${FEISHU_APP_ID}",
        appSecret: enableFeishu ? feishuAppSecret : "${FEISHU_APP_SECRET}",
        port: 3000,
      },
    },
    agents: { maxSpawnDepth: 1, maxConcurrent, defaultTimeout: 60000 },
    security: { defaultRole: "developer", auditLog: true, bashTimestamp: true },
    memory: { dataDir: "." },
    rag: { enabled: true, docsDir: "docs" },
    cron: { enabled: true, dataDir: "." },
    session: { id: "default" },
    usage: { trackingFile: ".usage/today.jsonl" },
  };

  // 写入配置文件
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n  ✓ ${CONFIG_FILE} 已生成`);

  // 7. 生成 .env 环境变量文件（如果提供了 API Key 或渠道凭证）
  const envLines: string[] = [];
  if (apiKey) envLines.push(`DASHSCOPE_API_KEY=${apiKey}`);
  if (enableFeishu && feishuAppId) {
    envLines.push(`FEISHU_APP_ID=${feishuAppId}`);
    envLines.push(`FEISHU_APP_SECRET=${feishuAppSecret}`);
  }
  if (envLines.length > 0) {
    fs.writeFileSync(".env", envLines.join("\n") + "\n");
    console.log("  ✓ .env 已生成");
  }

  console.log("\n  启动 Agent: pnpm start\n");
  rl.close();
}
