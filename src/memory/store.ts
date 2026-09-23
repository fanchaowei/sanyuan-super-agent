// 文件系统 API，用于创建、读取、写入和删除记忆文件。
import fs from 'node:fs';
// 路径 API，用于以跨平台方式拼接记忆目录和文件路径。
import path from 'node:path';

export interface MemoryEntry {
  /** 记忆的显示名称，也是索引中的链接标题。 */
  name: string;
  /** 对记忆内容的简短说明。 */
  description: string;
  /** 记忆来源类型，用于文件名分类和后续筛选。 */
  type: 'user' | 'feedback' | 'project' | 'reference';
  /** 记忆正文内容。 */
  content: string;
  /** 记忆文件在本地文件系统中的完整路径。 */
  filePath: string;
}

// 保存所有记忆文件的目录名。
const MEMORY_DIR = '.memory';
// 记忆索引文件名，里面保存指向各条记忆的 Markdown 链接。
const INDEX_FILE = 'MEMORY.md';
// 索引允许保留的最大行数，避免索引无限增长。
const MAX_INDEX_LINES = 200;
// 读取或注入 prompt 时单个文件允许使用的最大字符数。
const MAX_FILE_CHARS = 4000;

export class MemoryStore {
  // 工作区根目录；所有记忆路径都从这里计算出来。
  private readonly baseDir: string;

  /**
   * 创建记忆存储对象。
   * @param baseDir 保存记忆的工作区根目录，默认为当前目录。
   */
  constructor(baseDir: string = '.') {
    this.baseDir = baseDir;
  }

  /** 返回记忆目录路径；目录是否存在由 init() 负责保证。 */
  private get memoryDir(): string {
    return path.join(this.baseDir, MEMORY_DIR);
  }

  /** 返回记忆索引文件路径；该文件位于 memoryDir 下。 */
  private get indexPath(): string {
    return path.join(this.memoryDir, INDEX_FILE);
  }

  /**
   * 初始化记忆存储所需的目录和索引文件。
   * 方法可重复调用，因此所有读写入口都可以安全地先调用它。
   */
  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8');
    }
  }

  /** 将一条记忆写入独立 Markdown 文件，并同步更新索引。 */
  save(entry: Omit<MemoryEntry, 'filePath'>): string {
    this.init();
    // 将记忆名称规范化为适合文件名的 slug。
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '');
    // 通过类型前缀区分记忆来源，避免同名文件难以识别。
    const filename = `${entry.type}_${slug}.md`;
    // 当前记忆文件的保存路径。
    const filePath = path.join(this.memoryDir, filename);

    // 使用 YAML frontmatter 保存元数据，正文放在分隔线之后。
    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      '---',
      '',
      entry.content,
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    this.updateIndex(entry.name, filename, entry.description);
    return filename;
  }

  /**
   * 新增或更新 MEMORY.md 中的一条索引链接。
   * 如果 filename 已存在，则替换旧行，避免同一文件产生重复索引；
   * 如果不存在，则追加新行。索引超过上限时，先移除最早的记忆条目，
   * 但不会删除对应的记忆文件，文件内容仍可通过 list() 发现。
   * @param name 索引显示名称。
   * @param filename 目标记忆文件名。
   * @param description 显示在索引行中的摘要。
   */
  private updateIndex(name: string, filename: string, description: string): void {
    // 当前索引全文，后续会按行查找或追加条目。
    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    // 将索引拆成数组，便于原地替换或删除某一行。
    const lines = indexContent.split('\n');

    // 已存在同名文件对应的索引行下标；不存在时为 -1。
    // l：当前遍历到的索引行文本。
    const existingIdx = lines.findIndex(l => l.includes(`(${filename})`));
    // 根据记忆元数据生成新的 Markdown 索引行。
    const newLine = `- [${name}](${filename}) — ${description}`;

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine;
    } else {
      if (lines.length >= MAX_INDEX_LINES) {
        console.log(`[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`);
        // 找到最早的记忆条目，超限时只删除这一条。
        const firstEntry = lines.findIndex(l => l.startsWith('- '));
        if (firstEntry >= 0) lines.splice(firstEntry, 1);
      }
      lines.push(newLine);
    }

    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
  }

  /**
   * 扫描记忆目录并解析所有合法的 Markdown 记忆文件。
   * 索引文件会被排除；无法解析 frontmatter 的文件会被忽略。
   * @returns 可供程序使用的结构化记忆条目列表。
   */
  list(): MemoryEntry[] {
    this.init();
    // 收集所有成功解析的记忆条目。
    const entries: MemoryEntry[] = [];
    // 只读取 Markdown 记忆文件，并排除索引本身。
    // f：目录中当前遍历到的文件名。
    const files = fs.readdirSync(this.memoryDir)
      .filter(f => f.endsWith('.md') && f !== INDEX_FILE);

    // 逐个读取文件，并将 frontmatter 转换为结构化记忆对象。
    for (const file of files) {
      // 当前文件的完整路径。
      const filePath = path.join(this.memoryDir, file);
      // 当前文件的原始文本内容。
      const raw = fs.readFileSync(filePath, 'utf-8');
      // 解析出的元数据和正文；格式不合法时为 null。
      const parsed = this.parseFrontmatter(raw);
      if (parsed) {
        entries.push({ ...parsed, filePath });
      }
    }
    return entries;
  }

  /**
   * 按空白分隔查询词，在记忆名称、描述和正文中执行大小写不敏感搜索。
   * 任意一个关键词命中即可保留该条目。
   * @param query 要搜索的文本。
   * @returns 匹配的记忆条目。
   */
  search(query: string): MemoryEntry[] {
    // 先取得全部记忆，再在名称、描述和正文中进行匹配。
    const all = this.list();
    // 将查询拆成关键词；任意关键词命中即可返回该记忆。
    const keywords = query.toLowerCase().split(/\s+/);
    // entry：当前参与关键词匹配的记忆条目。
    return all.filter(entry => {
      // 合并可搜索字段并统一转为小写，实现大小写不敏感搜索。
      const text = `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
      // kw：当前待匹配的查询关键词。
      return keywords.some(kw => text.includes(kw));
    });
  }

  /**
   * 读取 MEMORY.md 的内容，并按 MAX_FILE_CHARS 限制返回长度。
   * @returns 索引文本；过长时在末尾附加截断提示。
   */
  loadIndex(): string {
    this.init();
    // 读取索引原文，并在过长时截断以控制上下文占用。
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
  }

  /**
   * 读取指定记忆文件的原文。
   * @param filename 记忆文件名，而不是完整路径。
   * @returns 文件内容；文件不存在时返回 null，过长内容会被截断。
   */
  loadFile(filename: string): string | null {
    // 目标记忆文件的完整路径。
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return null;
    // 读取记忆正文；过长内容只返回前 MAX_FILE_CHARS 个字符。
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
  }

  /**
   * 删除指定记忆文件，并移除 MEMORY.md 中对应的索引链接。
   * @param filename 要删除的记忆文件名。
   * @returns 文件实际被删除时为 true；文件不存在时为 false。
   */
  delete(filename: string): boolean {
    // 待删除记忆文件的完整路径。
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);

    // 删除索引中指向该文件的链接，保持索引与磁盘内容一致。
    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    // 过滤掉目标文件对应的索引行。
    const lines = indexContent.split('\n').filter(l => !l.includes(`(${filename})`));
    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
    return true;
  }

  /**
   * 生成可注入 system prompt 的记忆区块，只包含索引和使用提示。
   * 具体记忆正文不会全部注入，模型需要通过 memory 工具按需读取。
   * @returns 记忆区块文本；没有记忆时返回引导语。
   */
  buildPromptSection(): string {
    this.init();
    // 读取供模型查看的索引摘要，以及用于判断是否为空的完整条目列表。
    const index = this.loadIndex();
    const entries = this.list();

    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
    }

    // 组织注入 system prompt 的记忆说明和索引内容。
    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引：',
      index,
      '',
      '使用 memory 工具的 read 操作来读取具体记忆内容。',
      '记忆是线索，不是事实——使用前先验证其准确性。',
    ];
    return lines.join('\n');
  }

  /** 从 Markdown 文本中解析 frontmatter 和正文；格式不符合约定时返回 null。 */
  private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
    // 匹配开头的两段 --- 分隔线，并捕获中间元数据和后续正文。
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    // 暂存 frontmatter 中的键值对。
    const meta: Record<string, string> = {};
    // 逐行解析形如 key: value 的元数据。
    for (const line of match[1].split('\n')) {
      // 当前行中第一个冒号的位置。
      const idx = line.indexOf(':');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    // 允许写入的记忆类型白名单。
    const validTypes = ['user', 'feedback', 'project', 'reference'];
    if (!meta.name || !meta.type || !validTypes.includes(meta.type)) return null;

    // 返回解析后的记忆字段，filePath 由 list() 根据实际文件位置补充。
    return {
      name: meta.name,
      description: meta.description || '',
      type: meta.type as MemoryEntry['type'],
      content: match[2].trim(),
    };
  }
}
