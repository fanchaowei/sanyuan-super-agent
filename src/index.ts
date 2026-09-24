/**
 * SuperAgent 命令行主入口 (CLI Entry Point)
 *
 * 【作用】
 * 作为 npm/pnpm 启动或全局命令执行时的首要入口脚本。
 * 负责解析命令行入参，根据子命令路由至不同的执行流程（如初始化向导或主 Agent 会话运行）。
 *
 * 【具体执行流程】
 * 1. 从 process.argv 中获取传入的第一个参数作为子命令 command。
 * 2. 若 command 为 "init"：动态导入并执行配置向导 runInit()，引导用户交互式生成配置文件。
 * 3. 否则（默认）：动态导入并执行 startAgent() 启动 SuperAgent 主运行循环。
 */

/** 命令行子命令参数（如 "init" 等） */
const command: string | undefined = process.argv[2];

if (command === "init") {
  // 执行初始化配置向导
  import("./config/init.js").then((m) => m.runInit());
} else {
  // 启动主 Agent 对话和调度系统
  import("./main.js").then((m) => m.startAgent().catch(console.error));
}
