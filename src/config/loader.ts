import fs from 'node:fs';
import { SuperAgentConfigSchema, type SuperAgentConfig } from './schema.js';

/**
 * 默认配置文件名称
 * 智能体启动时默认从当前工作目录下查找该文件
 */
export const CONFIG_FILE = 'super-agent.config.json';

/**
 * 环境变量占位符匹配正则表达式
 * 匹配格式如：${API_KEY}、${DASHSCOPE_API_KEY} 等大写字母与下划线组成的环境变量标识
 */
const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * 递归替换配置对象中的环境变量占位符
 *
 * 【作用】
 * 在配置文件中支持通过 `${ENV_NAME}` 的形式引用系统环境变量（例如敏感的 API Key、动态端口等），
 * 该函数负责递归遍历整个配置数据结构，将其中的占位符动态替换为真实的环境变量值。
 *
 * 【具体执行流程】
 * 1. 若为字符串：使用正则全局匹配 `${VAR_NAME}`，从 `process.env` 中读取对应的值进行替换。若未找到则打印警告并保留原占位符。
 * 2. 若为数组：通过 `map` 递归处理数组中的每一项元素。
 * 3. 若为普通对象：遍历对象的所有键值对，递归处理每一个属性的值后组装返回新对象。
 * 4. 若为其他基础类型（布尔值、数字、null 等）：直接原样返回。
 *
 * @param obj 待处理的原始数据（可能是字符串、数组、嵌套对象或基本类型）
 * @returns 完成环境变量注入后的新数据结构
 */
function substituteEnvVars(obj: unknown): unknown {
  // 1. 处理字符串类型：执行正则替换
  if (typeof obj === 'string') {
    return obj.replace(ENV_VAR_RE, (match, name) => {
      const val = process.env[name];
      if (val === undefined) {
        console.warn(`  ⚠ 环境变量 ${name} 未设置，保留原值`);
        return match;
      }
      return val;
    });
  }

  // 2. 处理数组类型：对每个元素递归调用
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);

  // 3. 处理普通对象类型：对每个属性值递归调用
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }

  // 4. 其他类型（number, boolean, null, undefined）直接返回
  return obj;
}

/**
 * 加载、解析并校验 SuperAgent 配置文件
 *
 * 【作用】
 * 负责系统的配置初始化。读取指定的 JSON 配置文件，动态注入环境变量，
 * 并通过 Zod Schema 进行严格的类型校验和默认值补齐，最终返回类型安全的全局配置对象。
 *
 * 【具体执行流程】
 * 1. 检查文件存在性：若指定路径的配置文件不存在，则打印提示信息，并通过 Schema 解析空对象获得全量默认配置返回。
 * 2. 读取与 JSON 反序列化：读取文件文本并调用 `JSON.parse`。若 JSON 语法错误，捕获异常打印错误并终止进程（exit 1）。
 * 3. 环境变量注入：调用 `substituteEnvVars` 将配置内容中的 `${ENV_NAME}` 替换为实际环境变量值。
 * 4. Schema 结构与类型校验：使用 `SuperAgentConfigSchema.safeParse` 进行严格校验：
 *    - 校验失败：格式化打印所有校验失败的属性路径和具体错误原因，终止进程（exit 1）。
 *    - 校验成功：打印加载成功日志，并返回补充完整默认值后的配置对象 `result.data`。
 *
 * @param path 配置文件所在的文件系统路径，默认为 `super-agent.config.json`
 * @returns 经过校验并注入默认值后的完整配置对象 `SuperAgentConfig`
 */
export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
  // 步骤 1：检查配置文件是否存在，若不存在则回退至默认配置
  if (!fs.existsSync(path)) {
    console.log(`  未找到 ${path}，使用默认配置`);
    console.log('  运行 pnpm run init 生成配置文件\n');
    return SuperAgentConfigSchema.parse({});
  }

  // 步骤 2：读取并解析 JSON 文件内容
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`  ✗ 解析 ${path} 失败: ${(err as Error).message}`);
    process.exit(1);
  }

  // 步骤 3：递归替换配置中的环境变量占位符
  const substituted = substituteEnvVars(raw);

  // 步骤 4：通过 Zod Schema 进行运行时类型校验与默认值合并
  const result = SuperAgentConfigSchema.safeParse(substituted);
  if (!result.success) {
    console.error('  ✗ 配置文件校验失败:');
    for (const issue of result.error.issues) {
      console.error(`    ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  // 步骤 5：加载与校验成功，返回最终配置数据
  console.log(`  ✓ 已加载 ${path}`);
  return result.data;
}
