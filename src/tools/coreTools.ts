import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 工具执行上下文：cwd 用于解析相对路径，confirm 用于发起终端 y/n 人工确认 */
export interface ToolContext {
  cwd: string;
  confirm: (question: string) => Promise<boolean>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** 暴露给 LLM 的 JSON Schema 参数定义 */
  parameters: Record<string, unknown>;
  requiresApproval: boolean;
  execute: (rawArgs: unknown, ctx: ToolContext) => Promise<string>;
}

const readFileSchema = z.object({
  filePath: z.string().min(1, "filePath 不能为空"),
});

const writeFileSchema = z.object({
  filePath: z.string().min(1, "filePath 不能为空"),
  content: z.string(),
});

const runBashSchema = z.object({
  command: z.string().min(1, "command 不能为空"),
});

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("；");
}

const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取本地文本文件的完整内容。filePath 支持相对当前工作目录的路径或绝对路径。",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "要读取的文件路径" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = readFileSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const absolutePath = path.resolve(ctx.cwd, parsed.data.filePath);
    try {
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        return `读取失败：${absolutePath} 是一个目录，请指定具体文件路径。`;
      }
      return fs.readFileSync(absolutePath, "utf8");
    } catch (error) {
      return `读取失败：${(error as Error).message}`;
    }
  },
};

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "将内容写入指定路径的文件（覆盖写入），父级目录不存在时自动创建。执行前必须经过人工 y/n 确认。",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "目标文件路径" },
      content: { type: "string", description: "要写入的完整文件内容" },
    },
    required: ["filePath", "content"],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute(rawArgs, ctx) {
    const parsed = writeFileSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const absolutePath = path.resolve(ctx.cwd, parsed.data.filePath);
    const approved = await ctx.confirm(
      `允许写入文件 ${absolutePath}（${parsed.data.content.length} 字符）吗？`,
    );
    if (!approved) return "用户拒绝了写入操作，文件未做任何变更。";

    try {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, parsed.data.content, "utf8");
      const bytes = Buffer.byteLength(parsed.data.content, "utf8");
      return `已写入文件：${absolutePath}（${bytes} 字节）`;
    } catch (error) {
      return `写入失败：${(error as Error).message}`;
    }
  },
};

const runBashTool: ToolDefinition = {
  name: "run_bash",
  description:
    "在终端执行 shell 命令并返回输出，超时上限 15 秒。执行前必须经过人工 y/n 确认。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute(rawArgs, ctx) {
    const parsed = runBashSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const { command } = parsed.data;
    const approved = await ctx.confirm(`允许执行命令 \`${command}\` 吗？`);
    if (!approved) return "用户拒绝了命令执行，未做任何操作。";

    try {
      const stdout = execSync(command, {
        cwd: ctx.cwd,
        timeout: 15_000,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : "(命令执行成功，无标准输出)";
    } catch (error) {
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
  },
};

/** Phase 1 常驻核心工具集 */
export const coreTools: ToolDefinition[] = [readFileTool, writeFileTool, runBashTool];

export function getCoreTool(name: string): ToolDefinition | undefined {
  return coreTools.find((tool) => tool.name === name);
}

/** 转换为 OpenAI / DeepSeek function calling 所需的 tools 参数 */
export function getCoreToolSpecs(): ChatCompletionTool[] {
  return coreTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
