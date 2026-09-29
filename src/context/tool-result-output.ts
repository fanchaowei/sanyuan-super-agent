import type { ToolResultPart } from 'ai';

// 从 AI SDK 的 ToolResultPart 中提取 output 字段类型。
// 这是一个带有 type 判别字段的联合类型，switch 可以据此安全地缩小类型范围。
export type ToolResultOutput = ToolResultPart['output'];

/** 将普通字符串包装成 AI SDK 要求的工具结果结构。 */
export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: 'text', value };
}

/**
 * 将工具结果统一转换为文本，供日志展示和 token 数量估算使用。
 * 图片、文件等二进制内容只保留描述性标签，避免将实际数据重新放入上下文。
 */
export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    // 文本结果（包括错误文本）已经是最终可读形式。
    case 'text':
    case 'error-text':
      return output.value;
    // JSON 结果需要序列化，否则对象直接参与字符串操作时会丢失信息。
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'execution-denied':
      // 工具未获准执行时没有 value，优先保留调用方提供的原因。
      return output.reason ?? 'Tool execution denied';
    case 'content':
      // content 由多个文本或媒体 part 组成；转换后用换行连接并保持原顺序。
      return output.value
        .map(part => {
          if (part.type === 'text') {
            return part.text;
          }

          // data 类型通常有 mediaType；URL、id 和 custom 类型没有该字段，
          // 用 in 做运行时字段检查，避免读取不存在的属性。
          return 'mediaType' in part
            ? `[media: ${part.mediaType}]`
            : `[${part.type}]`;
        })
        .join('\n');
  }
}
