import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const TIER1_LIMIT = 4_000;
const TIER1_HEAD = 2_000;
const TIER1_TAIL = 1_000;
const DEFAULT_THRESHOLD_CHARS = 32_000;
const DEFAULT_KEEP_TOOL_ROUNDS = 3;
const DEFAULT_KEEP_RECENT_ROUNDS = 2;

const SUMMARY_SYSTEM_PROMPT = `你是对话历史压缩器。请把给定的 Agent 与用户的历史对话压缩为一份结构化中文摘要，供 Agent 在后续任务中继续使用。

要求：
1. 严格按三部分输出：
   - 已完成操作：按时间顺序列出关键操作与结论
   - 修改过的文件路径：列出所有被创建或修改的文件
   - 当前报错或阻塞点：记录尚未解决的问题、错误信息或待确认事项
2. 保留后续继续任务所必需的信息（文件名、命令、关键数据），删除寒暄与冗余内容。
3. 不要编造历史中不存在的信息；某部分为空时写“无”。`;

export interface ContextManagerOptions {
  client: OpenAI;
  model: string;
  /** 三级压缩成功后整体重写 JSONL 的回调 */
  persistCompacted: (messages: ChatCompletionMessageParam[]) => void;
  /** 触发三级摘要的字符阈值，默认 32000 */
  thresholdChars?: number;
  /** 二级微压缩保留完整工具输出的最近轮数，默认 3 */
  keepToolRounds?: number;
  /** 三级摘要后保留的最近轮数，默认 2 */
  keepRecentRounds?: number;
}

interface RoundSplit {
  preamble: ChatCompletionMessageParam[];
  rounds: ChatCompletionMessageParam[][];
}

/**
 * 三级上下文治理：
 * 一级（工具返回后）截断超长工具结果；二级（每次请求前）折叠历史工具输出；
 * 三级（超阈值时）将历史对话摘要压缩并回写 JSONL。
 */
export class ContextManager {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly persistCompacted: (messages: ChatCompletionMessageParam[]) => void;
  private readonly thresholdChars: number;
  private readonly keepToolRounds: number;
  private readonly keepRecentRounds: number;

  constructor(options: ContextManagerOptions) {
    this.client = options.client;
    this.model = options.model;
    this.persistCompacted = options.persistCompacted;
    this.thresholdChars = options.thresholdChars ?? DEFAULT_THRESHOLD_CHARS;
    this.keepToolRounds = options.keepToolRounds ?? DEFAULT_KEEP_TOOL_ROUNDS;
    this.keepRecentRounds = options.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS;
  }

  /** 一级治理：单个工具返回超过 4000 字符时，保留前 2000 + 后 1000，中间折叠 */
  budgetToolResult(result: string): string {
    if (result.length <= TIER1_LIMIT) return result;

    const head = result.slice(0, TIER1_HEAD);
    const tail = result.slice(-TIER1_TAIL);
    const omitted = result.length - TIER1_HEAD - TIER1_TAIL;
    return `${head}\n\n...[内容过长已截断，共省略 ${omitted} 字符]...\n\n${tail}`;
  }

  /** 每次请求大模型前调用：生成消息视图副本，必要时触发三级摘要压缩 */
  async prepareMessages(
    messages: ChatCompletionMessageParam[],
  ): Promise<ChatCompletionMessageParam[]> {
    let view = this.microcompact(messages);
    if (estimateChars(view) <= this.thresholdChars) return view;

    const { preamble, rounds } = splitRounds(messages);
    if (rounds.length <= this.keepRecentRounds) return view;

    const staleRounds = rounds.slice(0, rounds.length - this.keepRecentRounds);
    const recentRounds = rounds.slice(-this.keepRecentRounds);

    try {
      const summary = (await this.summarize(staleRounds.flat())).trim();
      if (!summary) return view;

      const summaryMessage: ChatCompletionMessageParam = {
        role: "user",
        content: `[历史对话摘要（自动压缩）]\n${summary}`,
      };
      const compacted: ChatCompletionMessageParam[] = [
        ...preamble,
        summaryMessage,
        ...recentRounds.flat(),
      ];

      this.persistCompacted(compacted);
      console.log(`\n[上下文压缩] 已将 ${staleRounds.length} 轮历史对话压缩为结构化摘要。`);
      return this.microcompact(compacted);
    } catch (error) {
      console.warn(`\n[上下文压缩] 三级摘要失败，降级为局部微压缩：${(error as Error).message}`);
      return view;
    }
  }

  /**
   * 二级治理：保留最近 keepToolRounds 轮的完整工具输出；
   * 更早的 tool 消息仅替换 content 为占位符，tool_call_id 配对保持不变。
   */
  private microcompact(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const { preamble, rounds } = splitRounds(messages);
    const keepFrom = Math.max(0, rounds.length - this.keepToolRounds);
    const toolNames = collectToolNames(messages);

    const view: ChatCompletionMessageParam[] = [...preamble];
    rounds.forEach((round, roundIndex) => {
      if (roundIndex >= keepFrom) {
        view.push(...round);
        return;
      }
      for (const message of round) {
        if (message.role === "tool") {
          const toolName = toolNames.get(message.tool_call_id) ?? "未知工具";
          view.push({
            ...message,
            content: `[历史工具输出已折叠：已执行 ${toolName}]`,
          });
        } else {
          view.push(message);
        }
      }
    });

    return view;
  }

  /** 三级治理使用的非流式摘要请求 */
  private async summarize(history: ChatCompletionMessageParam[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "system", content: SUMMARY_SYSTEM_PROMPT }, ...history],
      stream: false,
    });
    const content = response.choices[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
}

/** 以 user 消息为界，把消息切分为「前导 system 区」和「若干轮对话」 */
function splitRounds(messages: ChatCompletionMessageParam[]): RoundSplit {
  const preamble: ChatCompletionMessageParam[] = [];
  const rounds: ChatCompletionMessageParam[][] = [];
  let current: ChatCompletionMessageParam[] | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      current = [message];
      rounds.push(current);
    } else if (current) {
      current.push(message);
    } else {
      preamble.push(message);
    }
  }

  return { preamble, rounds };
}

function collectToolNames(messages: ChatCompletionMessageParam[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (call.type === "function") names.set(call.id, call.function.name);
    }
  }
  return names;
}

/** 粗略估算消息文本量（content + tool_calls JSON） */
function estimateChars(messages: ChatCompletionMessageParam[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") total += message.content.length;
    if (message.role === "assistant" && message.tool_calls) {
      total += JSON.stringify(message.tool_calls).length;
    }
  }
  return total;
}
