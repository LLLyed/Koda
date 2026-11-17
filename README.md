# Koda

轻量级终端编程智能体（Coding Agent），基于 TypeScript + Bun，规格见 [SPEC.md](SPEC.md)。

## 快速开始

```bash
bun install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
npx bun run src/index.ts
```

恢复历史会话：

```bash
npx bun run src/index.ts --resume session_<timestamp>
```

会话记录实时追加到 `.sessions/<sessionId>.jsonl`。

## 当前进度

- [x] Phase 1：CLI 交互、核心工具（read_file / write_file / run_bash + y/n 人工确认）、JSONL 会话持久化、流式 Agent Loop 与指数退避重试
- [ ] Phase 2：三级上下文治理
- [ ] Phase 3：扩展工具池 + TF-IDF 按需检索
- [ ] Phase 4：Subagent 隔离 + Langfuse 可观测性

## 脚本

```bash
bun run start       # 启动 CLI（等价于 bun run src/index.ts）
bun run typecheck   # 类型检查
```
