import { HookPipeline } from "../security/hooks";


export const registerMockSecurityHook = (hookPipeline: HookPipeline) => {
  // 示例 Pre Hook: 写文件前记录日志
  hookPipeline.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as any)?.path || 'unknown';
      console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
    }
    return { action: 'allow' };
  });

  // 示例 Post Hook: 给 bash 输出加时间戳
  hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
      const timestamp = new Date().toISOString();
      return {
        action: 'modify',
        modifiedOutput: `[${timestamp}]\n${output}`,
      };
    }
    return { action: 'allow' };
  });
}