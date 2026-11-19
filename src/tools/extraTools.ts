import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { formatZodError } from "./coreTools";
import type { ToolContext, ToolDefinition } from "./coreTools";

const SKIP_DIRS = new Set([".git", ".sessions", "node_modules", "dist", "out", "coverage"]);
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 200;

function resolvePath(cwd: string, target: string): string {
  return path.resolve(cwd, target);
}

function toDisplayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function* walkFiles(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }
}

function formatCommandFailure(error: unknown): string {
  const failure = error as Error & {
    status?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
  };
  const parts = [
    `命令执行失败（退出码：${failure.status ?? "未知"}${failure.signal ? `，信号：${failure.signal}` : ""}）`,
    `错误信息：${failure.message}`,
  ];
  const stdout = (failure.stdout ?? "").toString().trim();
  const stderr = (failure.stderr ?? "").toString().trim();
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return parts.join("\n");
}

function runCommand(cwd: string, command: string): string {
  try {
    const stdout = execSync(command, {
      cwd,
      timeout: 15_000,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : "(命令执行成功，无输出)";
  } catch (error) {
    return formatCommandFailure(error);
  }
}

// ===== list_dir =====
const listDirSchema = z.object({
  dirPath: z.string().optional().default("."),
});

const listDirTool: ToolDefinition = {
  name: "list_dir",
  description:
    "列出目录中的文件与子目录（ls / dir）。用于查看项目结构、当前文件夹内容、确认文件是否存在。默认列出当前工作目录。",
  parameters: {
    type: "object",
    properties: {
      dirPath: { type: "string", description: "要列出的目录路径，默认为当前工作目录" },
    },
    required: [],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = listDirSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const absolutePath = resolvePath(ctx.cwd, parsed.data.dirPath);
    try {
      const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
      if (entries.length === 0) {
        return `目录 ${toDisplayPath(ctx.cwd, absolutePath)} 为空。`;
      }

      const lines = entries
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
        )
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => {
          if (entry.isDirectory()) return `[DIR]  ${entry.name}/`;
          const size = fs.statSync(path.join(absolutePath, entry.name)).size;
          return `[FILE] ${entry.name} (${size} bytes)`;
        });

      const suffix =
        entries.length > MAX_LIST_ENTRIES
          ? `\n...(共 ${entries.length} 项，仅显示前 ${MAX_LIST_ENTRIES} 项)`
          : "";
      return `目录：${toDisplayPath(ctx.cwd, absolutePath)}\n${lines.join("\n")}${suffix}`;
    } catch (error) {
      return `列目录失败：${(error as Error).message}`;
    }
  },
};

// ===== search_text =====
const searchTextSchema = z.object({
  query: z.string().min(1, "query 不能为空"),
  dirPath: z.string().optional().default("."),
  maxResults: z.number().int().min(1).max(200).optional().default(50),
});

const searchTextTool: ToolDefinition = {
  name: "search_text",
  description:
    "在项目中按关键字搜索文件内容（grep / 搜索文本 / 查找字符串）。递归扫描目录，返回匹配的文件路径、行号与所在行内容，自动跳过 node_modules、.git 等目录。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "要搜索的关键字（大小写不敏感）" },
      dirPath: { type: "string", description: "搜索起始目录，默认当前工作目录" },
      maxResults: { type: "number", description: "最多返回的匹配条数，默认 50，最大 200" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = searchTextSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const { query, dirPath, maxResults } = parsed.data;
    const root = resolvePath(ctx.cwd, dirPath);
    try {
      if (!fs.statSync(root).isDirectory()) {
        return `搜索失败：${root} 不是目录。`;
      }
    } catch (error) {
      return `搜索失败：${(error as Error).message}`;
    }

    const keyword = query.toLowerCase();
    const matches: string[] = [];

    for (const filePath of walkFiles(root)) {
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        continue;
      }
      if (size > MAX_SCAN_FILE_BYTES) continue;

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;

      const displayPath = toDisplayPath(ctx.cwd, filePath);
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        if (!line.toLowerCase().includes(keyword)) continue;

        matches.push(`${displayPath}:${lineIndex + 1}: ${line.trim().slice(0, 200)}`);
        if (matches.length >= maxResults) break;
      }
      if (matches.length >= maxResults) break;
    }

    if (matches.length === 0) return `未找到包含 "${query}" 的文件内容。`;
    return `找到 ${matches.length} 处匹配：\n${matches.join("\n")}`;
  },
};

// ===== git_status =====
const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description:
    "查看 Git 工作区状态（git status）。显示当前分支、已修改、已暂存与未跟踪的文件，用于确认代码改动情况。",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  requiresApproval: false,
  async execute(_rawArgs, ctx) {
    return runCommand(ctx.cwd, "git status --short --branch");
  },
};

// ===== git_diff =====
const gitDiffSchema = z.object({
  staged: z.boolean().optional().default(false),
});

const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description:
    "查看 Git 未提交的代码差异（git diff）。默认查看工作区与暂存区差异，staged 为 true 时查看已暂存的差异。",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "是否查看已暂存（staged）的差异，默认 false" },
    },
    required: [],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = gitDiffSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;
    return runCommand(ctx.cwd, parsed.data.staged ? "git diff --staged" : "git diff");
  },
};

// ===== git_log =====
const gitLogSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(10),
});

const gitLogTool: ToolDefinition = {
  name: "git_log",
  description:
    "查看 Git 提交历史（git log --oneline），返回最近若干条提交记录，用于了解项目演进与变更内容。",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "返回的提交条数，默认 10，最大 100" },
    },
    required: [],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = gitLogSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;
    return runCommand(ctx.cwd, `git log --oneline -n ${parsed.data.limit}`);
  },
};

// ===== get_system_info =====
const systemInfoTool: ToolDefinition = {
  name: "get_system_info",
  description:
    "获取系统与运行时信息：操作系统、CPU 核数、内存占用、Bun / Node 版本、系统运行时长与当前工作目录。用于环境排查与兼容性确认。",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  requiresApproval: false,
  async execute(_rawArgs, ctx) {
    const totalMemory = os.totalmem() / 1024 ** 3;
    const freeMemory = os.freemem() / 1024 ** 3;
    const uptimeHours = (os.uptime() / 3600).toFixed(1);
    const bunVersion = typeof Bun !== "undefined" ? Bun.version : "非 Bun 运行时";

    return [
      `平台：${os.platform()} ${os.release()}（${os.arch()}）`,
      `CPU：${os.cpus().length} 核`,
      `内存：${totalMemory.toFixed(1)} GB 总计 / ${freeMemory.toFixed(1)} GB 可用`,
      `Bun 版本：${bunVersion}`,
      `Node 版本：${process.version}`,
      `系统运行时长：${uptimeHours} 小时`,
      `工作目录：${ctx.cwd}`,
    ].join("\n");
  },
};

// ===== check_port =====
const checkPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().optional().default("127.0.0.1"),
});

const checkPortTool: ToolDefinition = {
  name: "check_port",
  description:
    "检测本机端口是否已被占用或监听（端口探测 / netstat 替代），用于排查服务启动失败、端口冲突等问题。",
  parameters: {
    type: "object",
    properties: {
      port: { type: "number", description: "要检测的端口号（1-65535）" },
      host: { type: "string", description: "检测的主机地址，默认 127.0.0.1" },
    },
    required: ["port"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs) {
    const parsed = checkPortSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const { port, host } = parsed.data;
    return new Promise<string>((resolve) => {
      const socket = net.connect({ port, host });
      socket.setTimeout(1_500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(`端口 ${port} 已开放（${host} 上有服务监听）。`);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(`端口 ${port} 检测超时（${host}）。`);
      });
      socket.once("error", (error) => {
        socket.destroy();
        resolve(`端口 ${port} 未开放（${host}）：${error.message}`);
      });
    });
  },
};

// ===== delete_file =====
const deleteFileSchema = z.object({
  filePath: z.string().min(1, "filePath 不能为空"),
});

const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description:
    "删除指定的本地文件（需人工 y/n 确认）。仅支持删除单个文件，不支持删除目录。谨慎使用。",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "要删除的文件路径" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute(rawArgs, ctx) {
    const parsed = deleteFileSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const absolutePath = resolvePath(ctx.cwd, parsed.data.filePath);
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        return `删除失败：${absolutePath} 是目录，本工具仅支持删除文件。`;
      }
    } catch (error) {
      return `删除失败：${(error as Error).message}`;
    }

    const approved = await ctx.confirm(`允许删除文件 ${absolutePath} 吗？`);
    if (!approved) return "用户拒绝了删除操作，文件未做任何变更。";

    try {
      fs.unlinkSync(absolutePath);
      return `已删除文件：${absolutePath}`;
    } catch (error) {
      return `删除失败：${(error as Error).message}`;
    }
  },
};

// ===== append_file =====
const appendFileSchema = z.object({
  filePath: z.string().min(1, "filePath 不能为空"),
  content: z.string(),
});

const appendFileTool: ToolDefinition = {
  name: "append_file",
  description:
    "向已有文件末尾追加内容（append），父目录不存在时自动创建。适合写日志或增量补充文本，不会覆盖原内容。",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "目标文件路径" },
      content: { type: "string", description: "要追加的内容" },
    },
    required: ["filePath", "content"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = appendFileSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const absolutePath = resolvePath(ctx.cwd, parsed.data.filePath);
    try {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.appendFileSync(absolutePath, parsed.data.content, "utf8");
      const bytes = Buffer.byteLength(parsed.data.content, "utf8");
      return `已向 ${absolutePath} 追加 ${bytes} 字节内容。`;
    } catch (error) {
      return `追加失败：${(error as Error).message}`;
    }
  },
};

// ===== count_lines =====
const countLinesSchema = z.object({
  filePath: z.string().min(1, "filePath 不能为空"),
});

const countLinesTool: ToolDefinition = {
  name: "count_lines",
  description: "统计文件的代码行数、字符数与字节数（类似 wc -l），用于评估文件规模。",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "要统计的文件路径" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = countLinesSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const absolutePath = resolvePath(ctx.cwd, parsed.data.filePath);
    try {
      const content = fs.readFileSync(absolutePath, "utf8");
      const bytes = fs.statSync(absolutePath).size;
      const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
      const lineCount = normalized.length === 0 ? 0 : normalized.split(/\r?\n/).length;
      return `文件 ${absolutePath}：${lineCount} 行，${content.length} 字符，${bytes} 字节。`;
    } catch (error) {
      return `统计失败：${(error as Error).message}`;
    }
  },
};

// ===== find_files =====
const findFilesSchema = z.object({
  pattern: z.string().min(1, "pattern 不能为空"),
  dirPath: z.string().optional().default("."),
  maxResults: z.number().int().min(1).max(200).optional().default(50),
});

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

const findFilesTool: ToolDefinition = {
  name: "find_files",
  description:
    "按文件名通配符查找文件（find / glob），例如 *.ts、src/*.test.ts。递归扫描目录，返回匹配的文件路径。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "文件名或相对路径通配符，支持 * 与 ?" },
      dirPath: { type: "string", description: "搜索起始目录，默认当前工作目录" },
      maxResults: { type: "number", description: "最多返回的文件数，默认 50，最大 200" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = findFilesSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const root = resolvePath(ctx.cwd, parsed.data.dirPath);
    try {
      if (!fs.statSync(root).isDirectory()) {
        return `查找失败：${root} 不是目录。`;
      }
    } catch (error) {
      return `查找失败：${(error as Error).message}`;
    }

    const matcher = globToRegExp(parsed.data.pattern);
    const found: string[] = [];
    for (const filePath of walkFiles(root)) {
      const displayPath = toDisplayPath(ctx.cwd, filePath);
      if (!matcher.test(displayPath)) continue;
      found.push(displayPath);
      if (found.length >= parsed.data.maxResults) break;
    }

    if (found.length === 0) return `未找到匹配 "${parsed.data.pattern}" 的文件。`;
    return `找到 ${found.length} 个匹配文件：\n${found.join("\n")}`;
  },
};

// ===== http_get =====
const httpGetSchema = z.object({
  url: z.string().min(1, "url 不能为空"),
  timeoutMs: z.number().int().min(1_000).max(30_000).optional().default(10_000),
  maxChars: z.number().int().min(200).max(20_000).optional().default(5_000),
});

const httpGetTool: ToolDefinition = {
  name: "http_get",
  description:
    "发送 HTTP GET 请求获取网页或 API 响应（类似 curl），返回状态码、Content-Type 与响应正文，用于调试接口或查看在线资源。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "请求的 http/https URL" },
      timeoutMs: { type: "number", description: "请求超时毫秒数，默认 10000，最大 30000" },
      maxChars: { type: "number", description: "返回正文的最大字符数，默认 5000，最大 20000" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs) {
    const parsed = httpGetSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    let target: URL;
    try {
      target = new URL(parsed.data.url);
    } catch {
      return `请求失败：非法 URL "${parsed.data.url}"。`;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return `请求失败：仅支持 http/https 协议，当前为 ${target.protocol}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), parsed.data.timeoutMs);
    try {
      const response = await fetch(target, { signal: controller.signal });
      const text = await response.text();
      const truncated =
        text.length > parsed.data.maxChars
          ? `${text.slice(0, parsed.data.maxChars)}\n...[响应过长，已截断，共省略 ${text.length - parsed.data.maxChars} 字符]...`
          : text;
      const contentType = response.headers.get("content-type") ?? "unknown";
      return `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${truncated}`;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return `请求失败：${target.href} 超时（${parsed.data.timeoutMs}ms）。`;
      }
      return `请求失败：${(error as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
  },
};

/** 扩展工具池（按需检索，不直接暴露给主模型） */
export const extraTools: ToolDefinition[] = [
  listDirTool,
  searchTextTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  systemInfoTool,
  checkPortTool,
  deleteFileTool,
  appendFileTool,
  countLinesTool,
  findFilesTool,
  httpGetTool,
];

export function getExtraTool(name: string): ToolDefinition | undefined {
  return extraTools.find((tool) => tool.name === name);
}
