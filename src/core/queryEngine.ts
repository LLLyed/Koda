import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolContext } from "../tools/coreTools";
import { executeExposedTool, getExposedToolSpecs } from "../tools/registry";
import { ContextManager } from "./contextManager";
import type { SessionStore } from "./sessionStore";

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

export interface QueryEngineOptions {
  sessionStore: SessionStore;
  confirm: (question: string) => Promise<boolean>;
  maxSteps?: number;
  model?: string;
}

/**
 * 核心 Agent Loop 引擎：
 * 驱动「流式推理 → 拼接 tool_calls → 执行工具 → 回填 tool 消息 → 继续推理」的 ReAct 循环。
 */
export class QueryEngine {
  private readonly client: OpenAI;
  private readonly sessionStore: SessionStore;
  private readonly toolContext: ToolContext;
  private readonly contextManager: ContextManager;
  private readonly maxSteps: number;
  private readonly model: string;

  constructor(options: QueryEngineOptions) {
    this.sessionStore = options.sessionStore;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.model = options.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      // 关闭 SDK 自带重试，统一由 requestAssistantTurn 的指数退避策略控制
      maxRetries: 0,
    });
    this.toolContext = { cwd: process.cwd(), confirm: options.confirm };
    this.contextManager = new ContextManager({
      client: this.client,
      model: this.model,
      persistCompacted: (messages) => this.sessionStore.replaceMessages(messages),
    });
  }

  async runUserTurn(userInput: string): Promise<void> {
    this.sessionStore.append({ role: "user", content: userInput });

    let step = 0;
    while (step < this.maxSteps) {
      step += 1;

      const { content, toolCalls } = await this.requestAssistantTurn();

      if (toolCalls.length === 0) {
        this.sessionStore.append({ role: "assistant", content });
        return;
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

    console.log(`\n[Koda] 已达到单轮最大推理步数（${this.maxSteps}），自动结束本轮。`);
  }

  /** 指数退避重试包装：网络抖动时最多重试 MAX_RETRIES 次 */
  private async requestAssistantTurn(): Promise<{
    content: string;
    toolCalls: AssembledToolCall[];
  }> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await this.streamAssistantTurn();
      } catch (error) {
        lastError = error;
        if (attempt === MAX_RETRIES) break;

        const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
        process.stdout.write(
          `\n[网络异常] ${(error as Error).message}；${delay}ms 后重试（${attempt + 1}/${MAX_RETRIES}）...\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /** 单次流式请求：实时打印 delta.content，并完整拼接被分片的 tool_calls */
  private async streamAssistantTurn(): Promise<{
    content: string;
    toolCalls: AssembledToolCall[];
  }> {
    // 请求前执行二级微压缩 / 三级摘要压缩，返回治理后的消息视图
    const viewMessages = await this.contextManager.prepareMessages(
      this.sessionStore.getMessages(),
    );

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: viewMessages,
      tools: getExposedToolSpecs(),
      stream: true,
    });

    let content = "";
    let printedContent = false;
    const toolCallMap = new Map<number, AssembledToolCall>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        printedContent = true;
        process.stdout.write(delta.content);
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

    if (printedContent) process.stdout.write("\n");

    const toolCalls = [...toolCallMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));

    return { content, toolCalls };
  }

  /** 执行单个工具调用：JSON 解析 → Capability Layer 调度（含 Zod 校验与人工确认）→ 结果回填 */
  private async executeToolCall(call: AssembledToolCall): Promise<string> {
    process.stdout.write(`[工具] ${call.name} ${preview(call.argumentsText)}\n`);

    let args: unknown;
    try {
      args = call.argumentsText.trim() === "" ? {} : JSON.parse(call.argumentsText);
    } catch (error) {
      return `工具调用失败：arguments 不是合法 JSON（${(error as Error).message}）`;
    }

    try {
      // 工具返回后立即执行一级治理：超长结果截断头尾
      const result = this.contextManager.budgetToolResult(
        await executeExposedTool(call.name, args, this.toolContext),
      );
      process.stdout.write(`[工具结果] ${preview(result)}\n`);
      return result;
    } catch (error) {
      const message = this.contextManager.budgetToolResult(
        `工具执行异常：${(error as Error).message}`,
      );
      process.stdout.write(`${message}\n`);
      return message;
    }
  }
}

function preview(text: string, maxLength = 160): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return "(空)";
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}...`;
}
