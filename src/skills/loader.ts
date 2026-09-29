import fs from 'node:fs';
import path from 'node:path';

/** 从 SKILL.md 读取并标准化后的 Skill 定义。 */
export interface SkillDefinition {
  /** Skill 目录名称，也是激活 Skill 时使用的名称。 */
  name: string;
  /** Skill 的简短用途描述，用于展示可用 Skill 列表。 */
  description: string;
  /** Skill 的适用场景提示，可选。 */
  whenToUse?: string;
  /** 去除 frontmatter 后的 Skill 正文内容。 */
  content: string;
  /** Skill 所在目录的绝对/相对路径。 */
  dirPath: string;
}

/** 工作区中存放全部 Skill 子目录的目录名。 */
const SKILLS_DIR = '.skills';
/** 每个 Skill 目录约定使用的定义文件名。 */
const SKILL_FILE = 'SKILL.md';

/** 负责发现、解析、缓存和渲染工作区 Skill 的加载器。 */
export class SkillLoader {
  /** 工作区根目录，用于解析 `.skills` 目录。 */
  private readonly baseDir: string;
  /** 按 Skill 名称缓存已成功解析的定义。 */
  private skills = new Map<string, SkillDefinition>();

  /**
   * 创建 Skill 加载器。
   *
   * 处理流程：保存调用方提供的工作区根目录；后续所有 Skill 路径都基于该目录解析。
   *
   * @param baseDir 工作区根目录，默认为当前目录。
   */
  constructor(baseDir = '.') {
    this.baseDir = baseDir;
  }

  /** 获取工作区内 `.skills` 目录的完整路径。 */
  private get skillsDir(): string {
    return path.join(this.baseDir, SKILLS_DIR);
  }

  /**
   * 扫描并加载工作区中的全部 Skill。
   *
   * 处理流程：
   * 1. 清空旧缓存，避免删除或修改后的 Skill 残留在内存中。
   * 2. 检查 `.skills` 目录，不存在时返回空列表。
   * 3. 遍历子目录，仅处理包含 `SKILL.md` 的目录。
   * 4. 读取并解析 frontmatter；格式无效或解析失败的条目跳过。
   * 5. 组装标准定义并按名称写入缓存，最后返回缓存中的 Skill 列表。
   *
   * @returns 当前工作区成功加载的 Skill 定义列表。
   */
  load(): SkillDefinition[] {
    // 每次加载都从文件系统重新构建，确保结果反映最新文件内容。
    this.skills.clear();
    // 没有 Skill 根目录时视为当前工作区未配置 Skill。
    if (!fs.existsSync(this.skillsDir)) return [];

    // withFileTypes 可直接判断目录项类型，避免对普通文件额外拼接路径。
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    // 逐个检查 Skill 子目录及其定义文件。
    for (const entry of entries) {
      // 根目录下的普通文件不是有效 Skill 目录。
      if (!entry.isDirectory()) continue;
      // 每个 Skill 必须在自己的目录中提供 SKILL.md。
      const skillFile = path.join(this.skillsDir, entry.name, SKILL_FILE);
      if (!fs.existsSync(skillFile)) continue;

      // 读取原始 Markdown，随后从 frontmatter 和正文中提取元数据。
      const raw = fs.readFileSync(skillFile, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (!parsed) continue;

      // 目录名作为稳定名称，文件元数据补充描述、触发提示和正文。
      const skill: SkillDefinition = {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(this.skillsDir, entry.name),
      };
      this.skills.set(skill.name, skill);
    }

    return this.list();
  }

  /**
   * 返回当前缓存中的全部 Skill。
   *
   * 处理流程：读取 Map 的全部值并转换为数组；返回顺序遵循 Map 的插入顺序。
   */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * 按名称查找一个已加载的 Skill。
   *
   * @param name Skill 名称，通常对应其目录名。
   * @returns 找到的 Skill 定义；不存在时返回 undefined。
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * 构造可注入模型提示词的 Skill 区块。
   *
   * 处理流程：
   * 1. 没有已加载 Skill 时直接返回 null。
   * 2. 先输出 activeSkills 中实际存在的 Skill 正文，标记其为已激活。
   * 3. 再列出其余可用 Skill 的命令、描述和适用场景提示。
   * 4. 将各行用换行连接；若最终没有可输出内容则返回 null。
   *
   * @param activeSkills 当前希望注入完整正文的 Skill 名称集合。
   * @returns 可拼接到提示词中的文本；没有内容时返回 null。
   */
  buildPromptSection(activeSkills: Set<string>): string | null {
    // 没有 Skill 时不生成空提示词区块。
    if (this.skills.size === 0) return null;

    // 按行构建，最后统一拼接，便于控制段落和空行。
    const lines: string[] = [];

    // 先注入已激活 Skill 的完整内容。
    if (activeSkills.size > 0) {
      for (const name of activeSkills) {
        // 激活集合可能包含尚未加载或已删除的名称，需要安全跳过。
        const skill = this.skills.get(name);
        if (!skill) continue;
        lines.push(`[激活的 Skill: ${skill.name}]`);
        lines.push(skill.content);
        lines.push('');
      }
    }

    // 对未激活 Skill 只展示简短命令提示，避免将全部正文塞入提示词。
    const available = this.list()
      .filter(s => !activeSkills.has(s.name))
      .map(s => {
        // 适用场景为空时不追加多余括号。
        const hint = s.whenToUse ? ` (适用场景: ${s.whenToUse})` : '';
        return `  /${s.name} — ${s.description}${hint}`;
      });

    if (available.length > 0) {
      lines.push('可用的 Skills（输入 /skill load <name> 激活）：');
      lines.push(...available);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * 解析 SKILL.md 的 YAML 风格 frontmatter 和 Markdown 正文。
   *
   * 处理流程：
   * 1. 匹配开头和结尾的 `---` 分隔线，提取元数据区与正文区。
   * 2. 未找到 frontmatter 时，将整个原文作为正文并使用空描述。
   * 3. 按行拆分元数据，在第一个冒号处分离键和值，并去除包裹引号。
   * 4. 将 `description`、`when_to_use` 映射为标准字段，正文去除首尾空白。
   *
   * @param raw SKILL.md 的原始文本。
   * @returns 解析结果；当前实现对无 frontmatter 的文件提供兼容回退。
   */
  private parseFrontmatter(raw: string): { description: string; whenToUse?: string; content: string } | null {
    // frontmatter 必须位于文件开头，并由独立的 --- 行包围。
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    // 没有 frontmatter 仍保留正文，使简单 Markdown Skill 可以正常加载。
    if (!match) return { description: '', content: raw };

    // 使用字符串表暂存元数据，避免依赖完整 YAML 解析器。
    const meta: Record<string, string> = {};
    // 每行在第一个冒号处分割，允许值本身继续包含冒号。
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        // 键和值都去除外围空白，兼容常见的 `key: value` 写法。
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        // 去掉简单的单引号或双引号包裹，避免描述中带入格式字符。
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        meta[key] = value;
      }
    }

    // 将文件中的元数据键名映射到 SkillDefinition 使用的字段名。
    return {
      description: meta.description || '',
      whenToUse: meta.when_to_use || undefined,
      content: match[2].trim(),
    };
  }
}
