import fg from 'fast-glob';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ToolDefinition } from './tool-registry';


export const globTool: ToolDefinition = {
  name: 'glob',
  description: '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path = '.' }) => {
    // ... 递归遍历目录，匹配模式 ...
    // 自动跳过 node_modules 和 .git
    // 结果上限 100 条，防止大项目撑爆

    const results = await fg(pattern, {
      cwd: resolve(path),
      ignore: ['node_modules/**', '.git/**'],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
    return results.sort().join('\n');
  },
};

// 在传入的文件或目录下搜索文本内容，找出哪些行匹配 pattern，并返回匹配行的位置和内容。
export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ pattern, path = '.' }) => {
    // ... 递归搜索文件，正则匹配每一行 ...
    // 跳过 node_modules、.git、二进制文件
    // 返回格式：文件名:行号: 匹配内容
    // 上限 50 条匹配

    // 相对路径转换为绝对路径
    const baseDir = resolve(path);
    // 将搜索关键字转换为正则表达式
    const regex = new RegExp(pattern, 'i');
    // 储存搜索结果
    const matches: string[] = [];
    const SKIP = new Set(['node_modules', '.git', 'dist']);
    const BIN_EXT = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock']);

    function searchFile(filePath: string) {
      if (matches.length >= 50) return;
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      if (BIN_EXT.has(ext)) return;

      let content: string;
      try { content = readFileSync(filePath, 'utf-8'); } catch { return; }

      const lines = content.split('\n');
      // 把绝对文件路径转换成相对于搜索根目录的路径，便于结果阅读。
      const rel = relative(baseDir, filePath);
      // 逐行检查文件内容，命中时记录“相对路径:行号:行内容”。
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          // 最多保留 50 条结果，避免大项目里输出过多内容。
          if (matches.length >= 50) return;
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }

      for (const name of entries) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full);
          else searchFile(full);
        } catch { /* skip */ }
      }
    }

    // 获取文件或目录的详细信息
    const stat = statSync(baseDir);
    if (stat.isFile()) {
      searchFile(baseDir);
    } else {
      walk(baseDir);
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
    const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : '';
    return matches.join('\n') + suffix;
  },
};