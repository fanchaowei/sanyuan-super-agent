import { ToolRegistry } from "../tools/tool-registry.js";

/**
 * 统计并输出当前工具注册表（ToolRegistry）中的工具规模及 Token 占用
 *
 * 【作用】
 * 输出全部工具、活跃工具、延迟加载工具的数量分布，
 * 以及估算的 Token 消耗，便于观察和验证工具延迟加载（Deferred Tools）对上下文控制的效果。
 *
 * 【具体执行流程】
 * 1. 从 registry 中获取所有已注册工具列表及数量。
 * 2. 获取当前处于活跃（非延迟加载）状态的工具列表及数量。
 * 3. 计算预估活跃工具与延迟工具对应的 Token 开销。
 * 4. 格式化打印到控制台。
 *
 * @param registry 工具注册表实例
 */
export function countTools(registry: ToolRegistry): void {
  /** 已注册工具总数 */
  const allCount: number = registry.getAll().length;
  /** 当前处于活跃状态（直接参与 Prompt）的工具列表 */
  const activeTools = registry.getActiveTools();
  /** 估算的 Token 消耗分布 */
  const estimate = registry.countTokenEstimate();

  console.log("\n=== 工具统计 ===");
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`);
}
