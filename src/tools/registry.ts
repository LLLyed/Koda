import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { coreTools, formatZodError } from "./coreTools";
import type { ToolContext, ToolDefinition } from "./coreTools";
import { extraTools, getExtraTool } from "./extraTools";
import { ToolRetriever } from "./retriever";

/** 启动时为全部扩展工具建立 TF-IDF 索引 */
const retriever = new ToolRetriever(extraTools);

const searchExtraToolsSchema = z.object({
  query: z.string().min(1, "query 不能为空"),
});

const executeExtraToolSchema = z.object({
  toolName: z.string().min(1, "toolName 不能为空"),
  args: z.record(z.string(), z.unknown()).optional(),
});

const searchExtraToolsTool: ToolDefinition = {
  name: "SearchExtraTools",
  description:
    "按自然语言需求检索扩展工具库，返回相似度最高的 Top-3 扩展工具（名称、描述与 JSON 参数格式）。当核心工具无法完成某个操作时，先调用本工具发现可用的扩展工具，再用 ExecuteExtraTool 执行。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "自然语言描述想完成的操作，例如：查看目录、搜索文件内容、查看 git 历史、检查端口占用",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs) {
    const parsed = searchExtraToolsSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const results = retriever.search(parsed.data.query, 3);
    if (results.length === 0) {
      return `未找到与 "${parsed.data.query}" 相关的扩展工具。`;
    }

    const lines = results.map(
      (result, index) =>
        `${index + 1}. ${result.tool.name}（相关度 ${result.score.toFixed(3)}）\n` +
        `   描述：${result.tool.description}\n` +
        `   参数 JSON Schema：${JSON.stringify(result.tool.parameters)}`,
    );

    return (
      `找到 ${results.length} 个相关扩展工具：\n\n${lines.join("\n\n")}\n\n` +
      `调用方式：ExecuteExtraTool(toolName="<工具名>", args={...})`
    );
  },
};

const executeExtraToolTool: ToolDefinition = {
  name: "ExecuteExtraTool",
  description:
    "执行通过 SearchExtraTools 检索到的扩展工具。toolName 为工具名称，args 为符合该工具 JSON Schema 的参数对象；参数会经过 Zod 严格校验。",
  parameters: {
    type: "object",
    properties: {
      toolName: { type: "string", description: "扩展工具名称，例如 list_dir" },
      args: {
        type: "object",
        description: "扩展工具的参数对象，需符合该工具的 JSON Schema",
        additionalProperties: true,
      },
    },
    required: ["toolName"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = executeExtraToolSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const tool = getExtraTool(parsed.data.toolName);
    if (!tool) {
      return `未找到扩展工具 "${parsed.data.toolName}"，请先调用 SearchExtraTools 检索可用工具。`;
    }

    return tool.execute(parsed.data.args ?? {}, ctx);
  },
};

/**
 * Capability Layer：暴露给主模型的完整工具列表。
 * 仅包含 3 个常驻核心工具 + SearchExtraTools + ExecuteExtraTool，
 * 扩展工具的 Schema 不进入 System Prompt。
 */
export const exposedTools: ToolDefinition[] = [
  ...coreTools,
  searchExtraToolsTool,
  executeExtraToolTool,
];

/** 非只读 Subagent 使用的工具集（不含 SpawnSubagent，避免嵌套递归） */
export const subagentTools: ToolDefinition[] = exposedTools;

const READONLY_EXTRA_TOOL_NAMES = new Set([
  "list_dir",
  "search_text",
  "git_status",
  "git_diff",
  "git_log",
  "get_system_info",
  "check_port",
  "count_lines",
  "find_files",
  "http_get",
]);

/** 只读 Subagent 的工具集：read_file + 只读扩展工具，实现权限隔离 */
export const readonlyTools: ToolDefinition[] = [
  ...coreTools.filter((tool) => tool.name === "read_file"),
  ...extraTools.filter((tool) => READONLY_EXTRA_TOOL_NAMES.has(tool.name)),
];

const exposedToolMap = new Map(exposedTools.map((tool) => [tool.name, tool]));

export function getExposedTool(name: string): ToolDefinition | undefined {
  return exposedToolMap.get(name);
}

export async function executeExposedTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<string> {
  const tool = getExposedTool(name);
  if (!tool) {
    return `工具调用失败：不存在名为 "${name}" 的工具。可用工具：${exposedTools
      .map((item) => item.name)
      .join(", ")}`;
  }
  return tool.execute(rawArgs, ctx);
}

/** 转换为 OpenAI / DeepSeek function calling 所需的 tools 参数 */
export function getExposedToolSpecs(): ChatCompletionTool[] {
  return exposedTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
