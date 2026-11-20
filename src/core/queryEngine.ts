import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { telemetry } from "../telemetry/langfuse";
import type { ToolContext, ToolDefinition } from "../tools/coreTools";
import { ContextManager } from "./contextManager";
import type { MessageStore } from "./sessionStore";

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_MAX_STEPS = 30;
/** 网络抖动时的最大重试次数（不含首次请求） */
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

interface AssembledToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

interface AssistantTurnResult {
  content: string;
  toolCalls: AssembledToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface QueryEngineOptions {
  sessionStore: MessageStore;
  confirm: (question: string) => Promise<boolean>;
  /** 本次引擎可用的工具集（主代理 / Subagent 只读或读写子集） */
  tools: ToolDefinition[];
  sessionId: string;
  maxSteps?: number;
  model?: string;
  /** 是否输出流式内容与工具日志，默认 true（Subagent 使用 false） */
  verbose?: boolean;
  /** 是否为每次用户输入创建独立 Trace，默认 true（Subagent 使用 false，挂载到主 Trace） */
  traceUserInput?: boolean;
}

/**
 * 核心 Agent Loop 引擎：
 * 驱动「流式推理 → 拼接 tool_calls → 执行工具 → 回填 tool 消息 → 继续推理」的 ReAct 循环。
 */
export class QueryEngine {
  private readonly client: OpenAI;
  private readonly sessionStore: MessageStore;
  private readonly toolContext: ToolContext;
  private readonly contextManager: ContextManager;
  private readonly tools: ToolDefinition[];
  private readonly toolMap: Map<string, ToolDefinition>;
  private readonly toolSpecs: ChatCompletionTool[];
  private readonly maxSteps: number;
  private readonly model: string;
  private readonly verbose: boolean;
  private readonly sessionId: string;
  private readonly traceUserInput: boolean;

  constructor(options: QueryEngineOptions) {
    this.sessionStore = options.sessionStore;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.model = options.model ?? DEFAULT_MODEL;
    this.verbose = options.verbose ?? true;
    this.sessionId = options.sessionId;
    this.traceUserInput = options.traceUserInput ?? true;
    this.tools = options.tools;
    this.toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.toolSpecs = options.tools.map(
      (tool): ChatCompletionTool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }),
    );
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      // 关闭 SDK 自带重试，统一由 requestAssistantTurn 的指数退避策略控制
      maxRetries: 0,
    });
    this.toolContext = {
      cwd: process.cwd(),
      confirm: options.confirm,
      sessionId: this.sessionId,
    };
    this.contextManager = new ContextManager({
      client: this.client,
      model: this.model,
      persistCompacted: (messages) => this.sessionStore.replaceMessages(messages),
      verbose: this.verbose,
    });
  }

  /**
   * 处理一轮用户输入：驱动 ReAct 循环，返回最终文本结论。
   */
  async runUserTurn(userInput: string): Promise<string> {
    this.sessionStore.append({ role: "user", content: userInput });
    if (this.traceUserInput) telemetry.startTrace(this.sessionId, userInput);

    let lastContent = "";
    try {
      let step = 0;
      while (step < this.maxSteps) {
        step += 1;

        const { content, toolCalls } = await this.requestAssistantTurn();
        if (content.length > 0) lastContent = content;

        if (toolCalls.length === 0) {
          this.sessionStore.append({ role: "assistant", content });
          return content;
        }

        const assistantMessage: ChatCompletionMessageParam = {
          role: "assistant",
          content: content.length > 0 ? content : null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.argumentsText },
          })),
        };
        this.sessionStore.append(assistantMessage);

        for (const call of toolCalls) {
          const result = await this.executeToolCall(call);
          this.sessionStore.append({ role: "tool", tool_call_id: call.id, content: result });
        }
      }

      if (this.verbose) {
        console.log(`\n[Koda] 已达到单轮最大推理步数（${this.maxSteps}），自动结束本轮。`);
      }
      return lastContent;
    } finally {
      if (this.traceUserInput) telemetry.endTrace(lastContent);
    }
  }

  /** 指数退避重试包装：网络抖动时最多重试 MAX_RETRIES 次，每次请求记录 Generation */
  private async requestAssistantTurn(): Promise<AssistantTurnResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const generation = telemetry.startGeneration(this.model, {
        messageCount: this.sessionStore.getMessages().length,
        attempt: attempt + 1,
      });

      try {
        const result = await this.streamAssistantTurn();
        generation.end(result.content, result.usage);
        return result;
      } catch (error) {
        lastError = error;
        generation.end(`ERROR: ${(error as Error).message}`);

        if (attempt === MAX_RETRIES) break;

        const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
        this.log(
          `\n[网络异常] ${(error as Error).message}；${delay}ms 后重试（${attempt + 1}/${MAX_RETRIES}）...\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /** 单次流式请求：实时打印 delta.content，并完整拼接被分片的 tool_calls */
  private async streamAssistantTurn(): Promise<AssistantTurnResult> {
    // 请求前执行二级微压缩 / 三级摘要压缩，返回治理后的消息视图
    const viewMessages = await this.contextManager.prepareMessages(
      this.sessionStore.getMessages(),
    );

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: viewMessages,
      tools: this.toolSpecs,
      stream: true,
      stream_options: { include_usage: true },
    });

    let content = "";
    let printedContent = false;
    let usage: AssistantTurnResult["usage"];
    const toolCallMap = new Map<number, AssembledToolCall>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        printedContent = true;
        if (this.verbose) process.stdout.write(delta.content);
      }

      if (delta.tool_calls) {
        for (const piece of delta.tool_calls) {
          const assembled = toolCallMap.get(piece.index) ?? {
            id: "",
            name: "",
            argumentsText: "",
          };
          if (piece.id) assembled.id = piece.id;
          if (piece.function?.name) assembled.name += piece.function.name;
          if (piece.function?.arguments) assembled.argumentsText += piece.function.arguments;
          toolCallMap.set(piece.index, assembled);
        }
      }
    }

    if (printedContent && this.verbose) process.stdout.write("\n");

    const toolCalls = [...toolCallMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));

    return { content, toolCalls, usage };
  }

  /** 执行单个工具调用：JSON 解析 → 工具集调度（含 Zod 校验与人工确认）→ 结果回填 */
  private async executeToolCall(call: AssembledToolCall): Promise<string> {
    this.log(`[工具] ${call.name} ${preview(call.argumentsText)}\n`);
    const span = telemetry.startSpan(`tool:${call.name}`, { arguments: call.argumentsText });

    let result = "工具调用未执行。";
    const tool = this.toolMap.get(call.name);

    if (!tool) {
      result = `工具调用失败：不存在名为 "${call.name}" 的工具。可用工具：${this.tools
        .map((item) => item.name)
        .join(", ")}`;
    } else {
      let args: unknown;
      try {
        args = call.argumentsText.trim() === "" ? {} : JSON.parse(call.argumentsText);
      } catch (error) {
        result = `工具调用失败：arguments 不是合法 JSON（${(error as Error).message}）`;
      }

      if (args !== undefined) {
        try {
          result = this.contextManager.budgetToolResult(await tool.execute(args, this.toolContext));
        } catch (error) {
          result = this.contextManager.budgetToolResult(
            `工具执行异常：${(error as Error).message}`,
          );
        }
      }
    }

    span.end(result);
    this.log(`[工具结果] ${preview(result)}\n`);
    return result;
  }

  private log(text: string): void {
    if (this.verbose) process.stdout.write(text);
  }
}

function preview(text: string, maxLength = 160): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return "(空)";
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}...`;
}
