import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 会话目录：项目根目录下的 .sessions/ */
export const SESSIONS_DIR = path.resolve(process.cwd(), ".sessions");

/** QueryEngine 所需的最小消息存储接口（磁盘 JSONL 或纯内存实现） */
export interface MessageStore {
  getMessages(): ChatCompletionMessageParam[];
  append(message: ChatCompletionMessageParam): void;
  replaceMessages(messages: ChatCompletionMessageParam[]): void;
}

/**
 * JSONL 会话持久化：
 * 每条消息实时追加为一行 JSON；初始化时逐行反序列化，恢复完整的 messages 数组。
 */
export class SessionStore implements MessageStore {
  readonly sessionId: string;
  readonly filePath: string;
  private messages: ChatCompletionMessageParam[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  }

  static exists(sessionId: string): boolean {
    return fs.existsSync(path.join(SESSIONS_DIR, `${sessionId}.jsonl`));
  }

  /** 从 JSONL 文件恢复历史消息；文件不存在时返回空数组 */
  load(): ChatCompletionMessageParam[] {
    if (!fs.existsSync(this.filePath)) {
      this.messages = [];
      return this.messages;
    }

    const content = fs.readFileSync(this.filePath, "utf8");
    const messages: ChatCompletionMessageParam[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as ChatCompletionMessageParam);
      } catch {
        console.warn(`[SessionStore] 忽略无法解析的 JSONL 行：${trimmed.slice(0, 80)}`);
      }
    }

    this.messages = messages;
    return this.messages;
  }

  /** 实时追加一条消息：确保目录存在后以单行 JSON 写入磁盘，并同步内存中的消息列表 */
  append(message: ChatCompletionMessageParam): void {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(message)}\n`, "utf8");
    this.messages.push(message);
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /** 整体重写会话文件（用于三级摘要压缩后替换历史消息），先写临时文件再原子替换 */
  replaceMessages(messages: ChatCompletionMessageParam[]): void {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const content =
      messages.length > 0 ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n` : "";
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, this.filePath);
    this.messages = messages;
  }
}

/** 纯内存消息存储：供 Subagent 使用，独立空上下文且不落盘 */
export class MemorySessionStore implements MessageStore {
  private messages: ChatCompletionMessageParam[] = [];

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  append(message: ChatCompletionMessageParam): void {
    this.messages.push(message);
  }

  replaceMessages(messages: ChatCompletionMessageParam[]): void {
    this.messages = messages;
  }
}
