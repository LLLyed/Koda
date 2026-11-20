import { z } from "zod";
import { QueryEngine } from "../core/queryEngine";
import { MemorySessionStore } from "../core/sessionStore";
import { telemetry } from "../telemetry/langfuse";
import { formatZodError } from "../tools/coreTools";
import type { ToolDefinition } from "../tools/coreTools";
import { readonlyTools, subagentTools } from "../tools/registry";

const SUBAGENT_MAX_STEPS = 8;

const SUBAGENT_SYSTEM_PROMPT = `你是 Koda 的子代理，负责在独立上下文中完成主代理委派的子任务。

工作准则：
1. 使用提供的工具调查与执行，不要凭空猜测文件内容。
2. 只读模式下不存在任何写入、删除或执行命令的工具，不要尝试绕过。
3. 完成后用简体中文输出简洁的最终结论，包含关键文件路径与发现，不要输出寒暄。`;

const spawnSubagentSchema = z.object({
  task: z.string().min(1, "task 不能为空"),
  readonly: z.boolean().optional().default(false),
});

/**
 * SpawnSubagent：创建独立 QueryEngine 执行子任务。
 * 子代理使用独立空上下文（不写入主会话 JSONL）、最多 8 步推理，
 * readonly=true 时仅暴露只读工具，执行结束后只返回最终文本结论。
 */
export const spawnSubagentTool: ToolDefinition = {
  name: "SpawnSubagent",
  description:
    "启动一个隔离子代理执行独立的调查或子任务。子代理拥有独立上下文（不影响主会话），最多 8 步推理；readonly=true 时仅暴露只读工具（读取/搜索/查看类）。执行结束后只把最终文本结论返回给主代理。",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "交给子代理的完整子任务描述，需包含目标、范围与期望输出",
      },
      readonly: {
        type: "boolean",
        description: "是否启用只读模式（仅允许读取/搜索类工具），默认 false",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(rawArgs, ctx) {
    const parsed = spawnSubagentSchema.safeParse(rawArgs);
    if (!parsed.success) return `参数校验失败：${formatZodError(parsed.error)}`;

    const { task, readonly } = parsed.data;
    const span = telemetry.startSpan("subagent", { task, readonly });

    const store = new MemorySessionStore();
    store.append({ role: "system", content: SUBAGENT_SYSTEM_PROMPT });

    try {
      const engine = new QueryEngine({
        sessionStore: store,
        confirm: ctx.confirm,
        tools: readonly ? readonlyTools : subagentTools,
        sessionId: `${ctx.sessionId ?? "session"}:subagent_${Date.now()}`,
        maxSteps: SUBAGENT_MAX_STEPS,
        verbose: false,
        traceUserInput: false,
      });

      const conclusion = (await engine.runUserTurn(task)).trim();
      const result = conclusion.length > 0 ? conclusion : "子代理未产出文本结论。";
      span.end(result);
      return result;
    } catch (error) {
      const message = `子代理执行失败：${(error as Error).message}`;
      span.end(message);
      return message;
    }
  },
};
