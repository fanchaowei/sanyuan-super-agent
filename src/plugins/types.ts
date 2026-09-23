import type { ChannelDefinition } from '../channels/types.js';
import type { ToolDefinition } from '../tools/tool-registry.js';

/**
 * 插件配置项字典类型
 * 键为配置属性名称，值为字符串、数字或布尔值等基本类型
 */
export interface PluginConfig {
  [key: string]: string | number | boolean;
}

/**
 * 插件与宿主系统交互的 API 接口
 * 宿主在激活插件时向其提供该接口实例，插件可通过该接口注册工具、读取配置和输出日志
 */
export interface PluginApi {
  /**
   * 向宿主系统的工具注册表注册一批工具定义
   * 插件激活阶段调用此方法将自身提供的工具暴露给系统
   *
   * @param tools 要注册的工具定义数组
   */
  registerTools(tools: ToolDefinition[]): void;

  /**
   * 想宿主系统注册一个 channel
   * @param channel 要注册的符合 ChannelDefinition 格式的 channel 数据
   */
  registerChannel(channel: ChannelDefinition): void;  // 新增

  /**
   * 获取解析后的插件配置（包含环境变量解析与覆盖后的配置项）
   *
   * @returns 当前插件的有效配置对象
   */
  getConfig(): PluginConfig;

  /**
   * 输出带有当前插件上下文标识的日志信息
   *
   * @param message 日志消息文本
   */
  log(message: string): void;
}

/**
 * 插件定义规范接口
 * 描述一个插件的元数据以及生命周期钩子（activate / destroy）
 */
export interface PluginDefinition {
  /**
   * 插件唯一标识名称，同时作为其注册工具时的命名前缀
   */
  name: string;

  /**
   * 插件版本号，遵循语义化版本规范（例如 "1.0.0"）
   */
  version: string;

  /**
   * 插件功能描述，用于向用户或系统展示插件作用
   */
  description: string;

  /**
   * 插件默认配置项（可选），支持内嵌环境变量占位符（如 "${API_KEY}"）
   */
  config?: PluginConfig;

  /**
   * 插件激活生命周期方法
   * 当插件被加载时由插件管理器调用，插件需在此方法中通过 api 注册工具、读取配置或进行必要的异步/同步资源初始化
   *
   * @param api 宿主系统提供的插件上下文 API 实例
   */
  activate(api: PluginApi): Promise<void> | void;

  /**
   * 插件卸载与销毁生命周期方法（可选）
   * 当插件被卸载时由插件管理器调用，用于释放资源、关闭连接或取消监听等清理工作
   */
  destroy?(): Promise<void> | void;
}
