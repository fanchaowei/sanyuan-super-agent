import { SuperAgentConfig } from "../config/schema.js";
import { HookPipeline } from "../security/hooks.js";

/**
 * 注册模拟安全审计与命令拦截钩子（Security Hooks）
 *
 * 【作用】
 * 根据全局安全配置项（config.security），向安全管道（HookPipeline）注册前置（Pre Hook）和后置（Post Hook）安全拦截规则。
 * 用于实现文件写操作审计、命令执行时间戳注入等功能。
 *
 * 【具体执行流程】
 * 1. 检查 `config.security.auditLog` 是否开启：
 *    若开启，注册名为 "audit-log" 的 Pre Hook。当执行 `write_file` 或 `edit_file` 时，打印文件写入审计日志并允许执行。
 * 2. 检查 `config.security.bashTimestamp` 是否开启：
 *    若开启，注册名为 "bash-timestamp" 的 Post Hook。当 `bash` 工具执行完成时，在其输出内容前注入当前 ISO 时间戳并返回修改后的输出。
 *
 * @param hookPipeline 安全钩子管道管理器
 * @param config 全局 SuperAgent 配置对象
 */
export const registerMockSecurityHook = (
  hookPipeline: HookPipeline,
  config: SuperAgentConfig
): void => {
  // 1. 注册写文件操作审计 Pre Hook
  if (config.security.auditLog) {
    hookPipeline.registerPre("audit-log", (toolName, input) => {
      if (toolName === "write_file" || toolName === "edit_file") {
        const path = (input as any)?.path || "unknown";
        console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
      }
      return { action: "allow" };
    });
  }

  // 2. 注册 Bash 输出时间戳注入 Post Hook
  if (config.security.bashTimestamp) {
    hookPipeline.registerPost("bash-timestamp", (toolName, _input, output) => {
      if (toolName === "bash") {
        const timestamp = new Date().toISOString();
        return {
          action: "modify",
          modifiedOutput: `[${timestamp}]\n${output}`,
        };
      }
      return { action: "allow" };
    });
  }
};
