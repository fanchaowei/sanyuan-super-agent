import { z } from 'zod';

/**
 * 模型配置校验 Schema
 * 用于定义和校验大语言模型（LLM）服务提供商的连接配置
 */
export const ModelConfigSchema = z.object({
  /** 模型提供商类型，支持 dashscope（通义千问）、openai 或自定义兼容接口 */
  provider: z.enum(['dashscope', 'openai', 'custom']).default('dashscope'),
  /** 使用的模型名称标识 */
  name: z.string().default('qwen-plus-latest'),
  /** 模型接口的基础请求 URL */
  baseURL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  /** 模型调用鉴权所使用的 API 密钥 */
  apiKey: z.string().default(''),
});

/**
 * 插件配置校验 Schema
 * 用于定义单个外部插件的启用状态及自定义键值对参数
 */
export const PluginConfigSchema = z.object({
  /** 插件唯一标识名称 */
  name: z.string(),
  /** 是否启用该插件 */
  enabled: z.boolean().default(true),
  /** 插件自定义配置键值对映射表 */
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/**
 * 飞书渠道配置校验 Schema
 * 用于定义飞书机器人接收/发送消息的连接与鉴权配置
 */
export const FeishuChannelConfigSchema = z.object({
  /** 是否启用飞书渠道 */
  enabled: z.boolean().default(false),
  /** 飞书应用的 App ID */
  appId: z.string().default(''),
  /** 飞书应用的 App Secret */
  appSecret: z.string().default(''),
  /** 飞书 Webhook 接收服务的监听端口 */
  port: z.number().default(3000),
});

/**
 * 消息渠道集合配置校验 Schema
 * 聚合支持的所有交互渠道配置（如飞书等）
 */
export const ChannelConfigSchema = z.object({
  /** 飞书渠道配置 */
  feishu: FeishuChannelConfigSchema.prefault({}),
});

/**
 * 子智能体（Sub-Agent）派生与执行配置校验 Schema
 * 控制 Agent 的最大派生深度、并发数以及单次任务超时时间
 */
export const AgentConfigSchema = z.object({
  /** 允许递归派生子 Agent 的最大层级深度（0-5） */
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  /** 允许并行执行子任务的最大并发数（1-10） */
  maxConcurrent: z.number().min(1).max(10).default(3),
  /** 单个任务执行的默认超时时间（毫秒） */
  defaultTimeout: z.number().default(60000),
});

/**
 * 安全机制与权限配置校验 Schema
 * 配置 Agent 的默认角色、审计日志开关及命令安全时间戳记录
 */
export const SecurityConfigSchema = z.object({
  /** 智能体默认分配的角色权限 */
  defaultRole: z.string().default('developer'),
  /** 是否开启敏感操作的审计日志记录 */
  auditLog: z.boolean().default(true),
  /** 执行 Bash/Shell 命令时是否记录时间戳 */
  bashTimestamp: z.boolean().default(true),
});

/**
 * 记忆系统配置校验 Schema
 * 配置 Agent 长期记忆与向量数据库存储文件的保存目录
 */
export const MemoryConfigSchema = z.object({
  /** 记忆持久化数据存储目录路径 */
  dataDir: z.string().default('.'),
});

/**
 * RAG（检索增强生成）配置校验 Schema
 * 配置知识库文档的加载目录及 RAG 模块启用状态
 */
export const RagConfigSchema = z.object({
  /** 是否开启 RAG 知识检索增强功能 */
  enabled: z.boolean().default(true),
  /** 知识库源文档所在目录路径 */
  docsDir: z.string().default('docs'),
});

/**
 * 定时任务（Cron）配置校验 Schema
 * 配置计划任务持久化数据目录及模块启用状态
 */
export const CronConfigSchema = z.object({
  /** 是否启用定时调度模块 */
  enabled: z.boolean().default(true),
  /** 定时任务持久化数据存储目录路径 */
  dataDir: z.string().default('.'),
});

/**
 * 会话管理配置校验 Schema
 * 配置多轮对话的上下文会话标识
 */
export const SessionConfigSchema = z.object({
  /** 默认会话 ID */
  id: z.string().default('default'),
});

/**
 * Token 用量统计配置校验 Schema
 * 配置模型调用 Token 消耗与成本分析的日志记录文件路径
 */
export const UsageConfigSchema = z.object({
  /** Token 消耗日志输出文件路径（.jsonl 格式） */
  trackingFile: z.string().default('.usage/today.jsonl'),
});

/**
 * SuperAgent 顶层全局配置校验 Schema
 * 聚合系统所有子模块的配置项，提供统一的 Schema 验证和默认值填充
 */
export const SuperAgentConfigSchema = z.object({
  /** 配置文件格式版本号 */
  version: z.string().default('1.0'),
  /** 大语言模型相关配置 */
  model: ModelConfigSchema.prefault({}),
  /** 插件列表配置 */
  plugins: z.array(PluginConfigSchema).default([]),
  /** 消息通信渠道配置 */
  channels: ChannelConfigSchema.prefault({}),
  /** 子 Agent 派生与执行控制配置 */
  agents: AgentConfigSchema.prefault({}),
  /** 安全权限与审计配置 */
  security: SecurityConfigSchema.prefault({}),
  /** 长期记忆模块配置 */
  memory: MemoryConfigSchema.prefault({}),
  /** RAG 知识检索模块配置 */
  rag: RagConfigSchema.prefault({}),
  /** 定时任务模块配置 */
  cron: CronConfigSchema.prefault({}),
  /** 对话会话模块配置 */
  session: SessionConfigSchema.prefault({}),
  /** Token 用量追踪模块配置 */
  usage: UsageConfigSchema.prefault({}),
});

/**
 * SuperAgent 完整全局配置类型定义
 * 通过 Zod 自动推导出经过验证和默认值补充后的 TypeScript 类型
 */
export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
