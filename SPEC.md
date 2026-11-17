# Koda — 轻量级终端 Coding Agent 研发规格说明书 (SPEC)

适用场景：AI 编程助手（Qoder / Cursor / Claude Code）上下文工程指导与分阶段全栈开发规范

## 1. 项目概述与技术约束

| 项目 | 内容 |
| --- | --- |
| 项目名称 | Koda（轻量级终端编程智能体 / Coding Agent） |
| 核心定位 | 基于 TypeScript + Bun 的终端编程智能体，支持 LLM 流式响应、本地工具调用与人工权限校验、三级上下文压缩、JSONL 会话断点恢复、TF-IDF 工具按需检索、Subagent 子任务隔离及 Langfuse 全链路可观测性。 |
| 运行时与依赖 | 运行时：Bun（通过 `npx bun run src/index.ts` 启动）<br>核心依赖：`openai`（兼容 DeepSeek API）、`zod`、`dotenv`、`langfuse`（可选扩展：`@modelcontextprotocol/sdk`） |
| 环境变量配置 | 读取自根目录 `.env` 文件：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_HOST` |

## 2. 强制目录结构规范

请严格按照以下模块划分生成代码文件，保持高内聚低耦合：

```text
Koda/
├── src/
│   ├── index.ts                 # CLI 交互入口：处理命令行参数 (--resume) 与多轮用户输入
│   ├── core/
│   │   ├── queryEngine.ts       # 核心 Agent Loop 引擎：驱动 ReAct 循环与 SSE 流式响应
│   │   ├── contextManager.ts    # 三级上下文治理引擎：截断、Microcompact 与阈值摘要压缩
│   │   └── sessionStore.ts      # JSONL 会话持久化管理器：实时追加写入与历史状态恢复
│   ├── tools/
│   │   ├── registry.ts          # 工具注册中心：区分常驻核心工具与扩展工具 Capability Layer
│   │   ├── retriever.ts         # 工具检索引擎：基于 TF-IDF + 余弦相似度实现工具按需发现
│   │   ├── coreTools.ts         # 核心常驻工具集：read_file, write_file, run_bash (带人工确认)
│   │   └── extraTools.ts        # 扩展工具集：12+ 个细分开发工具 (Git/搜索/环境检测等)
│   ├── subagent/
│   │   └── runner.ts            # Subagent 执行器：独立空上下文实例与只读/读写权限隔离
│   └── telemetry/
│       └── langfuse.ts          # 可观测性埋点：封装 Trace, Generation, Span 追踪链路
├── .sessions/                   # 本地 JSONL 会话存储目录（需加入 .gitignore）
├── .env.example                 # 环境变量模板
├── SPEC.md                      # 本研发规格文档
└── package.json
```

## 3. 核心模块详细开发需求（分 4 个 Phase 逐步实现）

### Phase 1：基础 Agent Loop、工具调用与持久化（MVP 闭环）

- **1. CLI 入口 (`src/index.ts`)**：启动时解析 `process.argv`，若包含 `--resume <sessionId>` 则加载对应历史会话，否则生成新的 `session_<timestamp>`；使用 `readline` 实现交互式终端对话循环，支持输入 `exit` 优雅退出并打印恢复命令提示。
- **2. 核心常驻工具 (`src/tools/coreTools.ts`)**：所有工具入参必须使用 Zod 进行严格校验，包含以下 3 个基础工具：
  - `read_file(filePath)`：读取指定路径的本地文件内容。
  - `write_file(filePath, content)`：必须触发终端 y/n 人工权限校验，确认后自动创建父级目录并写入。
  - `run_bash(command)`：必须触发终端 y/n 人工权限校验，确认后使用 `execSync` 执行命令（设置 15s 超时保护）。
- **3. JSONL 会话持久化 (`src/core/sessionStore.ts`)**：每次新增消息（system / user / assistant / tool），实时以单行 JSON 格式追加写入 `.sessions/<sessionId>.jsonl`；初始化时若文件已存在，逐行反序列化恢复 messages 数组。
- **4. 核心循环引擎 (`src/core/queryEngine.ts`)**：接入 OpenAI SDK（指向 DeepSeek API），开启 `stream: true`。实现 `while (step < maxSteps)` 循环：实时流式打印 `delta.content`；若检测到流式 `delta.tool_calls`，完整拼接 id、name、arguments 后依次调用工具，将结果以 `role: "tool"` 回填进 messages 并进入下一轮推理；封装最多 3 次指数退避重试机制应对网络抖动。

### Phase 2：三级上下文治理机制 (`src/core/contextManager.ts`)

在每次请求大模型前及工具返回后执行三级上下文治理，防止长任务 Token 溢出：

- **一级治理（工具结果预算控制）**：单个工具返回字符串超过 4000 字符时，保留前 2000 字符与后 1000 字符，中间折叠为 `...[内容过长已截断，共省略 X 字符]...`。
- **二级治理（Microcompact 局部微压缩）**：每次发送请求前生成消息视图副本：保留最近 3 轮对话的完整 tool 返回内容；将 3 轮之前的历史 tool 消息替换为轻量化占位符（如 `[历史工具输出已折叠：已执行 read_file]`），保留消息结构完整性（不破坏 tool_call_id 配对）。
- **三级治理（阈值自动摘要压缩）**：粗略估算当前 messages 总字符数（如超过 32,000 字符，约合 16k Tokens）时，调用一次非流式 LLM 请求，将除 system 提示词及最近 2 轮外的历史对话总结为结构化摘要（包含：已完成操作、修改过的文件路径、当前报错或阻塞点），替换原历史消息并写入 JSONL。

### Phase 3：工具规模扩展与 TF-IDF 按需发现 (`retriever.ts` & `registry.ts`)

避免大量扩展工具的 JSON Schema 撑爆 System Prompt 并干扰模型选择：

- **1. 扩展工具池 (`src/tools/extraTools.ts`)**：编写至少 12 个实用开发工具（可用 Node 原生 API 或子进程命令实现）：`list_dir`、`search_text`（关键字搜索文件内容）、`git_status`、`git_diff`、`git_log`、`get_system_info`、`check_port`、`delete_file`（需人工确认）、`append_file`、`count_lines`、`find_files`、`http_get`。
- **2. TF-IDF + 余弦相似度检索引擎 (`src/tools/retriever.ts`)**：纯 TypeScript 实现轻量级分词（支持中英文字符与下划线拆分）、词频（TF）、逆文档频率（IDF）计算及向量余弦相似度计算；启动时为所有扩展工具的 name + description 建立索引。
- **3. Capability Layer 调度 (`src/tools/registry.ts`)**：暴露给主模型的工具列表仅包含：3 个常驻核心工具 + `SearchExtraTools` + `ExecuteExtraTool`。
  - `SearchExtraTools(query)`：调用检索器返回相似度最高的 Top-3 扩展工具的名称、描述及 JSON 参数格式说明。
  - `ExecuteExtraTool(toolName, args)`：查找对应扩展工具，经 Zod 校验参数后执行并返回结果。

### Phase 4：Subagent 子任务隔离与 Langfuse 可观测性

- **1. Subagent 执行器 (`src/subagent/runner.ts`)**：注册核心工具 `SpawnSubagent(task, readonly)`。触发时创建独立 QueryEngine 实例（独立空 messages、不污染主会话 JSONL、`maxSteps = 8`）。若 `readonly = true`，仅向该 Subagent 暴露只读工具（`read_file`、`list_dir`、`search_text` 等），实现工具权限隔离。执行结束后，仅将最终文本结论作为 tool 结果返回给主 Agent。
- **2. Langfuse 链路追踪 (`src/telemetry/langfuse.ts`)**：接入 langfuse SDK（若未配置 `.env` 中的 Langfuse Key，需静默降级为无操作 Mock，确保程序不报错）。每次用户输入创建 Trace（绑定 sessionId），每次大模型请求创建 Generation（记录耗时与 Token），每次工具调用和 Subagent 运行创建 Span。

## 4. Qoder 协作执行指令（分步发送给 Qoder）

建议在 Qoder 中分 4 次发送以下指令，每完成一步运行 `npx bun run src/index.ts` 测试通过后再推进下一步：

| 执行阶段 | 发送给 Qoder 的标准指令内容 |
| --- | --- |
| 第一轮指令<br>(Phase 1 MVP) | `@SPEC.md` 请先帮我创建项目目录结构、`.env.example`，并完整实现 Phase 1 的所有代码（`src/index.ts`, `src/core/sessionStore.ts`, `src/tools/coreTools.ts`, `src/core/queryEngine.ts`）。注意兼容 Bun 运行时和 DeepSeek API 流式输出。 |
| 第二轮指令<br>(Phase 2 压缩) | `@SPEC.md` Phase 1 已测试通过。现在请实现 Phase 2 的三级上下文治理模块（`src/core/contextManager.ts`），并将其集成到 QueryEngine 中。 |
| 第三轮指令<br>(Phase 3 检索) | `@SPEC.md` 请实现 Phase 3 的扩展工具池（`extraTools.ts`）、TF-IDF + 余弦相似度检索器（`retriever.ts`）以及统一工具调度层（`registry.ts`），并更新 QueryEngine 的工具注册逻辑。 |
| 第四轮指令<br>(Phase 4 隔离与监控) | `@SPEC.md` 请实现 Phase 4 的 Subagent 隔离执行器（`src/subagent/runner.ts`）和 Langfuse 链路追踪模块（`src/telemetry/langfuse.ts`），确保未配置 Langfuse 密钥时也能安全降级运行。 |

## 5. 验收建议

让 Qoder 生成完每个阶段的代码后，务必通读核心逻辑并在关键函数旁补充中文注释，方便后续面试时对答如流。
