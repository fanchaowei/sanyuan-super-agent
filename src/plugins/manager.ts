import type { ChannelDefinition } from '../channels/types.js';
import type { ToolDefinition, ToolRegistry } from '../tools/tool-registry.js';
import type { PluginApi, PluginConfig, PluginDefinition } from './types.js';

/**
 * 已加载插件的内部封装结构
 * 记录插件的定义信息及其向全局注册表注册的所有工具名称列表
 */
interface LoadedPlugin {
  /** 插件定义对象（元数据及生命周期方法） */
  definition: PluginDefinition;
  /** 该插件注册的所有工具名称列表（带前缀） */
  tools: string[];
}

/**
 * 插件管理器
 *
 * 负责插件生命周期管理（加载、激活、注销、清理）以及插件工具与全局 ToolRegistry 的集成：
 * 1. 管理插件的加载与唯一性校验
 * 2. 处理插件配置中的环境变量占位符注入与合并
 * 3. 构造隔离的 PluginApi 注入到插件 activate 方法中
 * 4. 自动为插件注册的工具名称和描述添加命名空间前缀 (`${pluginName}__${toolName}`)
 * 5. 管理插件卸载时的生命周期 destroy 触发和工具反注册
 */
export class PluginManager {
  /** 已加载插件的哈希表映射，以插件名称（name）为键 */
  private plugins = new Map<string, LoadedPlugin>();

  /** 全局工具注册表实例，插件注册的工具将被同步到该注册表中 */
  private registry: ToolRegistry;

  /**
   * 构造函数，初始化插件管理器并绑定工具注册表
   *
   * @param registry 全局工具注册表实例
   */
  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * 加载并激活指定的插件
   *
   * 整体流程：
   * 1. 检查插件是否已加载，若已加载则抛出错误
   * 2. 合并插件默认配置与外部传入配置，并解析 `${VAR}` 格式的环境变量占位符
   * 3. 构造传递给插件的 `PluginApi` 实现：
   *    - `registerTools`: 遍历插件工具列表，统一添加 `${pluginName}__` 前缀与描述标识后注册到 `ToolRegistry`
   *    - `getConfig`: 返回当前插件解析后的有效配置
   *    - `log`: 输出带插件前缀的控制台日志
   * 4. 调用插件的 `activate(api)` 钩子方法初始化插件
   * 5. 保存已加载状态并返回已注册的全部工具名称
   *
   * @param definition 插件定义对象
   * @param config 外部传入的自定义插件配置（可选，将覆盖插件默认配置）
   * @returns 成功注册的工具名称列表（带命名空间前缀）
   * @throws 当插件名称重复或激活过程报错时抛出异常
   */
  async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
    if (this.plugins.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`);
    }

    const resolvedConfig = this.resolveEnvVars({
      ...definition.config,
      ...config,
    });

    const registeredTools: string[] = [];

    const api: PluginApi = {
      registerTools: (tools: ToolDefinition[]) => {
        for (const tool of tools) {
          const prefixedName = `${definition.name}__${tool.name}`;
          const prefixedTool: ToolDefinition = {
            ...tool,
            name: prefixedName,
            description: `[Plugin:${definition.name}] ${tool.description}`,
          };
          this.registry.register(prefixedTool);
          registeredTools.push(prefixedName);
        }
      },
      registerChannel: (channel: ChannelDefinition) => {
        // TODO: 实现 channel 注册逻辑
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => {
        console.log(`  [plugin:${definition.name}] ${message}`);
      },
    };

    try {
      await definition.activate(api);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`);
      throw err;
    }

    this.plugins.set(definition.name, {
      definition,
      tools: registeredTools,
    });

    return registeredTools;
  }

  /**
   * 卸载指定的插件
   *
   * 整体流程：
   * 1. 查找已加载插件实例，未找到则直接返回 false
   * 2. 若插件定义了 `destroy` 钩子，则执行清理逻辑（捕获并打印销毁期异常）
   * 3. 从工具注册表中反注册该插件添加的所有工具
   * 4. 从内部插件映射中移除该插件并返回 true
   *
   * @param name 要卸载的插件名称
   * @returns 是否成功卸载（如果插件不存在返回 false，否则返回 true）
   */
  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
      }
    }

    for (const toolName of plugin.tools) {
      this.registry.unregister(toolName);
    }

    this.plugins.delete(name);
    return true;
  }

  /**
   * 卸载所有当前已加载的插件
   *
   * 依次对每个已加载插件调用 `unload` 方法进行清理与工具反注册
   */
  async unloadAll(): Promise<void> {
    const names = Array.from(this.plugins.keys());
    for (const name of names) {
      await this.unload(name);
    }
  }

  /**
   * 根据插件名称获取已加载的插件详情
   *
   * @param name 插件名称
   * @returns 匹配的已加载插件对象，若未找到则返回 undefined
   */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * 列出所有当前已加载插件的摘要信息
   *
   * @returns 包含每个插件名称、版本、描述和关联工具列表的摘要数组
   */
  list(): Array<{ name: string; version: string; description: string; tools: string[] }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
      tools: p.tools,
    }));
  }

  /**
   * 解析配置项中的环境变量占位符
   *
   * 遍历配置项，如果值为 `${ENV_VAR_NAME}` 格式的字符串，则从 `process.env` 中读取对应环境变量值进行替换；
   * 若环境变量不存在则置为空字符串 `""`，其余非占位符类型的值保持原样。
   *
   * @param config 原始配置对象
   * @returns 替换占位符后的解析配置对象
   */
  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const envKey = value.slice(2, -1);
        resolved[key] = process.env[envKey] || '';
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
