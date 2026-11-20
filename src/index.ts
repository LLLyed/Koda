import "dotenv/config";
import * as readline from "node:readline";
import { QueryEngine } from "./core/queryEngine";
import { SessionStore } from "./core/sessionStore";
import { spawnSubagentTool } from "./subagent/runner";
import { telemetry } from "./telemetry/langfuse";
import { exposedTools } from "./tools/registry";

const SYSTEM_PROMPT = `你是 Koda，一个运行在用户终端中的轻量级编程智能体。

工作准则：
1. 需要了解文件内容时必须先调用 read_file，不要凭空猜测。
2. 除核心工具外还有扩展工具（目录、文本搜索、Git、系统信息、端口检测等）：先调用 SearchExtraTools(query) 检索 Top-3 工具，再用 ExecuteExtraTool(toolName, args) 执行。
3. write_file、run_bash、delete_file 会触发人工确认；若用户拒绝，请停止重复尝试并询问下一步。
4. 回复使用简体中文，保持简洁，任务完成后给出简短总结。`;

interface CliOptions {
  resumeSessionId?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const flagIndex = argv.indexOf("--resume");
  if (flagIndex === -1) return {};

  const sessionId = argv[flagIndex + 1];
  if (!sessionId) {
    console.error("用法：npx bun run src/index.ts [--resume <sessionId>]");
    process.exit(1);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    console.error(`[Koda] 非法的 sessionId：${sessionId}`);
    process.exit(1);
  }
  return { resumeSessionId: sessionId };
}

function printResumeHint(sessionId: string): void {
  console.log(`恢复本次会话：npx bun run src/index.ts --resume ${sessionId}`);
}

async function main(): Promise<void> {
  const { resumeSessionId } = parseArgs(process.argv.slice(2));

  if (!process.env.DEEPSEEK_API_KEY) {
    console.error(
      "[Koda] 未检测到 DEEPSEEK_API_KEY，请先复制 .env.example 为 .env 并填写密钥。",
    );
    process.exit(1);
  }

  if (resumeSessionId && !SessionStore.exists(resumeSessionId)) {
    console.error(`[Koda] 会话不存在：${resumeSessionId}`);
    process.exit(1);
  }

  const sessionId = resumeSessionId ?? `session_${Date.now()}`;
  const store = new SessionStore(sessionId);

  if (resumeSessionId) {
    const restored = store.load();
    console.log(`[Koda] 已恢复会话 ${sessionId}（${restored.length} 条历史消息）`);
  } else {
    store.append({ role: "system", content: SYSTEM_PROMPT });
    console.log(`[Koda] 新会话：${sessionId}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let exiting = false;

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, resolve);
    });

  const confirm = async (question: string): Promise<boolean> => {
    const answer = (await ask(`${question} (y/n) `)).trim().toLowerCase();
    return answer === "y" || answer === "yes" || answer === "是";
  };

  const engine = new QueryEngine({
    sessionStore: store,
    confirm,
    tools: [...exposedTools, spawnSubagentTool],
    sessionId,
  });

  const flushAndExit = async (): Promise<void> => {
    await telemetry.shutdown();
    process.exit(0);
  };

  const shutdown = (message: string): void => {
    exiting = true;
    console.log(message);
    printResumeHint(sessionId);
    rl.close();
    void flushAndExit();
  };

  rl.on("SIGINT", () => shutdown("\n[Koda] 已中断。"));
  rl.on("close", () => {
    if (!exiting) {
      exiting = true;
      printResumeHint(sessionId);
      void flushAndExit();
    }
  });

  console.log("输入内容开始对话，输入 exit 退出。\n");

  while (true) {
    let input: string;
    try {
      input = (await ask("\n你 > ")).trim();
    } catch {
      break;
    }

    if (!input) continue;
    if (input === "exit" || input === "quit") {
      shutdown("\n[Koda] 再见！");
      return;
    }

    try {
      await engine.runUserTurn(input);
    } catch (error) {
      console.error(`\n[Koda] 本轮处理失败：${(error as Error).message}`);
    }
  }
}

main().catch((error) => {
  console.error(`[Koda] 启动失败：${(error as Error).message}`);
  process.exit(1);
});
