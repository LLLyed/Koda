import { Langfuse } from "langfuse";
import type { LangfuseTraceClient } from "langfuse";

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface GenerationHandle {
  end(output: string, usage?: TokenUsage): void;
}

export interface SpanHandle {
  end(output: string): void;
}

const NOOP_GENERATION: GenerationHandle = { end: () => {} };
const NOOP_SPAN: SpanHandle = { end: () => {} };

/**
 * Langfuse 链路追踪封装：
 * 未配置 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 时静默降级为无操作 Mock，
 * 所有埋点调用都不会报错。
 */
class Telemetry {
  private readonly client: Langfuse | null;
  private currentTrace: LangfuseTraceClient | null = null;

  constructor() {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;

    this.client =
      publicKey && secretKey
        ? new Langfuse({
            publicKey,
            secretKey,
            baseUrl: process.env.LANGFUSE_HOST || undefined,
          })
        : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** 每次用户输入创建 Trace，并绑定 sessionId */
  startTrace(sessionId: string, input: string): void {
    if (!this.client) return;
    this.currentTrace = this.client.trace({
      name: "koda-user-turn",
      sessionId,
      input,
    });
  }

  endTrace(output: string): void {
    this.currentTrace?.update({ output });
    this.currentTrace = null;
  }

  /** 每次大模型请求创建 Generation，记录耗时与 Token 用量 */
  startGeneration(model: string, input: unknown): GenerationHandle {
    if (!this.currentTrace) return NOOP_GENERATION;

    const startedAt = Date.now();
    const generation = this.currentTrace.generation({
      name: "llm-request",
      model,
      input,
      startTime: new Date(),
    });

    return {
      end: (output, usage) => {
        generation.end({
          output,
          usage:
            usage && (usage.promptTokens !== undefined || usage.completionTokens !== undefined)
              ? {
                  input: usage.promptTokens,
                  output: usage.completionTokens,
                  total: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
                }
              : undefined,
          metadata: { latencyMs: Date.now() - startedAt },
        });
      },
    };
  }

  /** 每次工具调用 / Subagent 运行创建 Span */
  startSpan(name: string, input?: unknown): SpanHandle {
    if (!this.currentTrace) return NOOP_SPAN;

    const startedAt = Date.now();
    const span = this.currentTrace.span({ name, input, startTime: new Date() });

    return {
      end: (output) => {
        span.end({
          output,
          metadata: { latencyMs: Date.now() - startedAt },
        });
      },
    };
  }

  /** 进程退出前刷新队列（未启用时为空操作） */
  async shutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.shutdownAsync();
    } catch {
      // 观测性失败不影响主流程
    }
  }
}

export const telemetry = new Telemetry();
