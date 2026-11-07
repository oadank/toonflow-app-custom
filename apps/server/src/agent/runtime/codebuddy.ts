import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, StopReason, TextContent, ThinkingContent, ToolCall, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent, AgentMention } from "@/agent/runtime/types";
import type { ThinkingLevel } from "@/lib/modelReasoning";

/**
 * CodeBuddy 引擎：把 Toonflow 的 agent 循环外包给本机 codebuddy.exe（multica 同款跑法）。
 *
 * 与 pi-coding-agent 的 ModelRuntime 不同，这里 spawn 一个完整 agent 进程：
 *  - 每个工作目录写 CODEBUDDY.md（人设/规矩/工具说明），codebuddy 靠 cwd 自动发现；
 *  - Toonflow 自己的 55 个 MCP 工具通过 toonflow-mcp-bridge.js 挂进去；
 *  - stdin/stdout 走 stream-json，事件转成 Toonflow 的 AgentEvent；
 *  - --port 0 必须带：本机 WorkBuddy 会话的 CLI 常驻 127.0.0.1:51000，不带会 EADDRINUSE。
 *
 * 运行中的「中途插队」：收到 steer 消息时杀掉当前子进程，带 --resume 把消息作为下一轮输入重开；
 * followUp 则等当前轮结束后再以 --resume 续跑。会话文件由本文件补写（codebuddy 自己不会写 Toonflow 的 jsonl）。
 */

const MARKER_BEGIN = "<!-- BEGIN TOONFLOW-CODEBUDDY (auto-managed; do not edit) -->";
const MARKER_END = "<!-- END TOONFLOW-CODEBUDDY -->";
const DEFAULT_CLI = "C:\\Users\\oadan\\bin\\codebuddy.exe";
const DEFAULT_NODE = "C:/Program Files/nodejs/node.exe";
const DEFAULT_BRIDGE = "C:/D/opt/Toonflow/adapter/toonflow-mcp-bridge.js";
const DEFAULT_DATA_DIR = "C:\\D\\opt\\Toonflow\\data";
const SESSION_MAP = ".agent/codebuddy-sessions.json";

let lastRunId = "";
/** 给积分看板用：最近一次 codebuddy run 的标记，官方账按这个串切出本轮扣分。 */
export function getLastCodebuddyRunId() {
  return lastRunId;
}

/** 每轮 run 的元数据。真实扣分由 codebuddyCredits.ts 从 CLI 会话记录里现算，不猜、不乘倍率。 */
export type CodeBuddyRunRecord = {
  runId: string;
  sessionId: string;
  modelId: string;
  at: number;
  startedAt: number;
};
const codebuddyRuns: CodeBuddyRunRecord[] = [];
export function getCodebuddyRuns() {
  return codebuddyRuns.slice();
}

/** 运行中收到的新消息（steer=插队立即处理 / followUp=本轮结束后处理）。 */
export type CodebuddyQueuedInput = { id: string; prompt: string; mode: "steer" | "followUp" };
type ActiveCodebuddyRun = {
  runId: string;
  sessionFile: string;
  steer: CodebuddyQueuedInput[];
  followUp: CodebuddyQueuedInput[];
  interrupt: () => void;
};
const activeCodebuddyRuns = new Map<string, ActiveCodebuddyRun>();
export function getActiveCodebuddyRun(sessionFile: string) {
  return activeCodebuddyRuns.get(sessionFile);
}
export function enqueueCodebuddyInput(sessionFile: string, input: CodebuddyQueuedInput) {
  const run = activeCodebuddyRuns.get(sessionFile);
  if (!run) return undefined;
  if (input.mode === "steer") { run.steer.push(input); run.interrupt(); }
  else run.followUp.push(input);
  return run;
}

export type CodeBuddyAgentOptions = {
  prompt: string;
  attachments?: { path?: string; name?: string; mimeType?: string; content?: string }[];
  mentions?: AgentMention[];
  cwd: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  sessionFile?: string;
  runId?: string;
  canvas?: CanvasContext;
  signal?: AbortSignal;
  onCancel?: () => void;
};

type SessionMap = Record<string, string>;

function dataDir() {
  return process.env.TOONFLOW_DATA_DIR || DEFAULT_DATA_DIR;
}

// 从 Toonflow 的 settings.json 按 modelId 取该模型的真实上下文窗口。
// 之前硬编码 192000 会把所有模型的窗口都按 192000 算，百分比是错的；
// settings.json 里每个 customProvider 模型都配了 contextWindow（如 dsv4.1f=192000、个别=1000000）。
let contextWindowCache: { mtime: number; map: Map<string, number> } | null = null;
function modelContextWindow(modelId: string): number {
  const p = join(dataDir(), "settings.json");
  try {
    const mtime = statSync(p).mtimeMs;
    if (!contextWindowCache || contextWindowCache.mtime !== mtime) {
      const data = JSON.parse(readFileSync(p, "utf8")) as {
        settings?: { customProviders?: Array<{ id: string; models?: Array<{ id: string; contextWindow?: number }> }> };
      };
      const map = new Map<string, number>();
      for (const cp of data.settings?.customProviders ?? []) {
        for (const m of cp.models ?? []) {
          if (typeof m.contextWindow === "number") map.set(m.id, m.contextWindow);
        }
      }
      contextWindowCache = { mtime, map };
    }
    return contextWindowCache.map.get(modelId) ?? 192000;
  } catch {
    return 192000;
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // WorkBuddy 桌面会话会把 CODEBUDDY_*/WORKBUDDY_* 注入子进程，
  // 不清掉会让新 CLI 试图复用同一个 gateway/会话（51000 冲突、串会话）。
  for (const key of Object.keys(env)) {
    if (/^WORKBUDDY_/.test(key) || /^CODEBUDDY_(SESSION_ID|CONVERSATION|MCP_CONFIG|HOST|GATEWAY|A2A_|APPROVAL|PROMPT|COMMAND)/.test(key)) delete env[key];
  }
  // 🔴 nssm 服务 toonflow 跑在 LocalSystem，USERPROFILE 被指到 Toonflow\data\profile。
  // codebuddy CLI 的登录态在老大用户目录，不显式指回去会报「未登录」，agent 直接废。
  const home = process.env.TOONFLOW_CODEBUDDY_HOME || "C:\\Users\\oadan";
  env.USERPROFILE = home;
  env.HOMEDRIVE = home.slice(0, 2);
  env.HOMEPATH = home.slice(2);
  env.APPDATA = `${home}\\AppData\\Roaming`;
  env.LOCALAPPDATA = `${home}\\AppData\\Local`;
  env.CODEBUDDY_CONFIG_DIR = process.env.TOONFLOW_CODEBUDDY_CONFIG_DIR || `${home}\\.codebuddy`;
  return env;
}

async function readSessionMap(cwd: string): Promise<SessionMap> {
  try {
    return JSON.parse(await readFile(join(cwd, SESSION_MAP), "utf8")) as SessionMap;
  } catch {
    return {};
  }
}

async function writeCodebuddyMd(cwd: string) {
  const path = join(cwd, "CODEBUDDY.md");
  let existing = "";
  try {
    if ((await stat(path)).isFile()) existing = await readFile(path, "utf8");
  } catch { /* 首次运行没有这个文件 */ }
  if (existing && !existing.includes(MARKER_BEGIN)) {
    await writeFile(`${path}.bak-${Date.now()}`, existing, "utf8");
  }
  let rules = "";
  try {
    rules = await readFile(join(dataDir(), "AGENTS.md"), "utf8");
  } catch { /* 全局规范可选 */ }
  const body = [
    MARKER_BEGIN,
    "# Toonflow Agent（CodeBuddy 引擎驱动）",
    "",
    "你是 Toonflow 工作台里的 agent。画布、文档、文件、媒体生成、技能、提示词配方、记忆都由 MCP 提供：",
    "- `toonflow`：55 个工具，操作当前画布/项目一律用它，不要自己猜文件路径。",
    "- `openmem`：老大的偏好、规矩、本机环境、过往项目，动手前先查，不许凭印象猜。",
    "",
    `工作目录：${cwd}`,
    // 🔴 这一行必须永远固定，绝不能写入 canvas.id 之类的动态值。
    //    本文件会被 codebuddy 收进 system prompt（在内置指令+工具定义之后、对话历史之前），
    //    一旦它每轮都变，40 万 token 的对话历史前缀缓存全部作废，一轮首跳从 0.4 分变 11 分
    //    （2026-11-07 实测：缓存命中每次精准停在 25600 = 本文件之前的长度）。
    //    画布 id 改放在本轮 user message 末尾（见 buildPrompt），不影响任何前缀。
    "当前画布：见本轮消息末尾的 [当前画布 xxx]；没有就用 toonflow 的 getAppState 查 connectionId。",
    "",
    "## 全局协作规范",
    rules || "（未配置 AGENTS.md）",
    "",
    MARKER_END,
    "",
  ].join("\n");
  // 内容一字未变就不碰磁盘（mtime 不变），避免任何形式的「同内容重写」惊动缓存。
  if (existing === body) return;
  await writeFile(path, body, "utf8");
}

async function writeMcpConfig(dir: string) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "mcp-config.json");
  const config = {
    mcpServers: {
      toonflow: {
        type: "stdio",
        command: process.env.TOONFLOW_CODEBUDDY_NODE || DEFAULT_NODE,
        args: [process.env.TOONFLOW_CODEBUDDY_BRIDGE || DEFAULT_BRIDGE],
        env: { TOONFLOW_DATA_DIR: dataDir() },
      },
      openmem: { type: "http", url: "http://127.0.0.1:3466/mcp" },
    },
  };
  await writeFile(path, JSON.stringify(config), "utf8");
  return path;
}

function buildPrompt(options: CodeBuddyAgentOptions, runId: string) {
  // 官方账单每行的 input 是明文首条消息，带这个标记才能精确切出「本轮」而不混进别的会话。
  const parts = [`[TOONFLOW-CB-RUN:${runId}]\n${options.prompt.trim()}`];
  for (const item of options.attachments ?? []) {
    if (item.content) parts.push(`\n\n[附件 ${item.name ?? item.path ?? "文本"}]\n${item.content}`);
    else if (item.path) parts.push(`\n\n[附件路径 ${item.path}]（用 toonflow 的 read/listFiles 读取）`);
  }
  for (const item of options.mentions ?? []) {
    parts.push(`\n\n[提及 ${item.label}] ${JSON.stringify(item.value ?? item.source)}`);
  }
  // 画布 id 放本条消息最末尾：不影响历史前缀缓存，agent 照样知道自己在哪个画布。
  if (options.canvas?.id) parts.push(`\n\n[当前画布 ${options.canvas.id}]`);
  return parts.join("");
}

function effortOf(level?: ThinkingLevel) {
  if (!level || level === "off") return undefined;
  return level;
}

export async function runCodeBuddyAgent(options: CodeBuddyAgentOptions, send: (event: AgentEvent) => void) {
  const { cwd, modelId, signal, onCancel } = options;
  const startedAt = Date.now();
  signal?.throwIfAborted();
  await writeCodebuddyMd(cwd);
  const tempDir = join(tmpdir(), `toonflow-codebuddy-${randomUUID()}`);
  const mcpConfigPath = await writeMcpConfig(tempDir);

  // —— 持久化到 Toonflow 会话文件 ——
  // codebuddy 是外挂进程，不会写 Toonflow 的 .agent/sessions/*.jsonl。不写的话：
  //  · 刷新后 /api/agent/get 读不到这些轮次 → 界面丢聊天记录；
  //  · 切回 main（pi 引擎）时 pi 也看不到这些轮次 → 上下文断裂。
  // 🔴 新对话首次运行时 sessionFile 为空（pi 是 run 里现建的），这里必须自己补建，
  //    否则这一轮连文件都没有，前端刷新后整个对话消失（2026-11-07 用户报「历史记录没了」就是这个）。
  const runId = options.runId ?? randomUUID();
  lastRunId = runId;
  let sessionFile = options.sessionFile;
  let history: SessionManager | undefined;
  try {
    const sessionsDir = join(cwd, ".agent", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    if (!sessionFile) {
      const created = SessionManager.create(cwd, sessionsDir);
      sessionFile = basename(created.getSessionFile()!);
      await writeFile(
        join(sessionsDir, sessionFile),
        [created.getHeader(), ...created.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n",
        "utf8",
      );
    }
    history = SessionManager.open(join(sessionsDir, sessionFile), sessionsDir, cwd);
    // 告诉前端文件名，后续刷新/落盘靠它定位。
    send({ type: "session", file: sessionFile, runId });
  } catch { history = undefined; }
  const emptyUsage = (): Usage => ({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  let pendingBlocks: (TextContent | ThinkingContent | ToolCall)[] = [];
  const toolNames = new Map<string, string>();
  const flushAssistant = (usage?: Usage) => {
    if (!history) { pendingBlocks = []; return; }
    if (!pendingBlocks.length && !usage) return;
    try {
      history.appendMessage({
        role: "assistant", content: pendingBlocks,
        api: "openai-completions", provider: options.providerId, model: options.modelId,
        usage: usage ?? emptyUsage(), stopReason: "stop" as StopReason, timestamp: Date.now(),
      } satisfies AssistantMessage);
    } catch { /* 持久化失败不影响运行 */ }
    pendingBlocks = [];
  };
  const persistUser = (text: string) => {
    if (!history) return;
    try {
      const userEntryId = history.appendMessage({
        role: "user", content: [{ type: "text", text }], timestamp: Date.now(),
      } satisfies UserMessage);
      history.appendCustomEntry("toonflowUserMessage", { messageId: userEntryId, content: text, attachments: [] });
    } catch { /* ignore */ }
  };
  // 先落第一条用户消息（原始 prompt，不带 [TOONFLOW-CB-RUN] 计费标记）
  persistUser(options.prompt.trim());

  const map = await readSessionMap(cwd);
  const cli = process.env.TOONFLOW_CODEBUDDY_CLI || DEFAULT_CLI;
  const effort = effortOf(options.thinkingLevel);
  let sessionId = sessionFile ? (map[sessionFile] ?? "") : "";
  let interruptChild: (() => void) | undefined;

  const active: ActiveCodebuddyRun | undefined = sessionFile ? {
    runId, sessionFile, steer: [], followUp: [],
    interrupt: () => interruptChild?.(),
  } : undefined;
  if (active) activeCodebuddyRuns.set(active.sessionFile, active);

  const cbMarker = `[TOONFLOW-CB-RUN:${runId}]\n`;
  const steerGuidance = "[当前任务中的引导]\n"
    + "这条消息是在当前任务执行过程中补充的引导。结合此前已完成的工作和工具结果继续，不要把原任务当成已结束的上一轮。"
    + "如果用户提出简短问题，先回答，再继续尚未完成的工作；若用户明确取消、替换或暂停原任务，按最新要求处理。不要重复已经完成的操作。\n用户本次补充：";

  type TurnOutcome = { sessionId: string; killedForSteer: boolean; aborted: boolean; error?: string };

  async function runTurn(turnPrompt: string): Promise<TurnOutcome> {
    const args = [
      "-p", "--port", "0",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--model", modelId,
      "--permission-mode", process.env.TOONFLOW_CODEBUDDY_PERMISSION || "acceptEdits",
      "--disallowedTools", "AskUserQuestion",
      "--mcp-config", mcpConfigPath,
    ];
    if (effort) args.push("--effort", effort);
    if (sessionId) args.push("--resume", sessionId);

    const child = spawn(cli, args, { cwd, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderrBuf = "";
    let killedForSteer = false;
    let aborted = false;
    let turnSessionId = sessionId;
    let settled = false;
    let resolveTurn!: (outcome: TurnOutcome) => void;
    const done = new Promise<TurnOutcome>(resolve => { resolveTurn = resolve; });
    const settle = (outcome: TurnOutcome) => { if (settled) return; settled = true; resolveTurn(outcome); };
    const killForSteer = () => { if (settled || killedForSteer) return; killedForSteer = true; try { child.kill(); } catch { /* 已退出 */ } };
    interruptChild = killForSteer;
    const onAbort = () => { if (settled) return; aborted = true; onCancel?.(); try { child.kill(); } catch { /* 已退出 */ } };
    signal?.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    const handle = (line: string) => {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const type = event.type as string;
      if (type === "system" && event.subtype === "init") {
        turnSessionId = String(event.session_id ?? turnSessionId);
        return;
      }
      if (type === "assistant") {
        const message = event.message as {
          content?: Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; input?: Record<string, unknown> }>;
        } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "text" && block.text) {
            send({ type: "text", blockId: randomUUID(), content: block.text, done: true });
            pendingBlocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && block.thinking) {
            send({ type: "thinking", blockId: randomUUID(), content: block.thinking, done: true });
            pendingBlocks.push({ type: "thinking", thinking: block.thinking });
          } else if (block.type === "tool_use" && block.id && block.name) {
            // codebuddy 在 --strict-mcp-config 下会把 MCP 工具包成 ToolSearch + DeferExecuteTool，
            // 这里原样转发；前端 messageList 已支持 tool 渲染，至少能看到「在调工具 + 调了什么 + 结果」。
            send({ type: "tool", blockId: block.id, tool: { id: block.id, name: block.name, args: block.input, status: "running" } });
            toolNames.set(block.id, block.name);
            pendingBlocks.push({ type: "toolCall", id: block.id, name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> });
          }
        }
        return;
      }
      if (type === "user") {
        // codebuddy 把工具执行结果以 user 消息的 tool_result block 回灌，这里把完成态回写对应 tool。
        const message = event.message as {
          content?: Array<{ type: string; tool_use_id?: string; content?: Array<{ type: string; text?: string }> | string }>;
        } | undefined;
        let flushed = false;
        for (const block of message?.content ?? []) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const parts = Array.isArray(block.content)
              ? block.content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
              : String(block.content ?? "");
            // 工具调用块必须落在 toolResult 之前，否则重载时找不到配对。
            if (!flushed) { flushAssistant(); flushed = true; }
            if (history) {
              try {
                history.appendMessage({
                  role: "toolResult", toolCallId: block.tool_use_id,
                  toolName: toolNames.get(block.tool_use_id) ?? "tool",
                  content: [{ type: "text", text: parts }], isError: false, timestamp: Date.now(),
                } satisfies ToolResultMessage);
              } catch { /* ignore */ }
            }
            send({ type: "tool", blockId: block.tool_use_id, tool: { id: block.tool_use_id, status: "success", result: parts } });
          }
        }
        return;
      }
      if (type === "result") {
        if (turnSessionId) {
          codebuddyRuns.unshift({ runId, sessionId: turnSessionId, modelId, at: Date.now(), startedAt });
          if (codebuddyRuns.length > 50) codebuddyRuns.length = 50;
        }
        // 🔴 用量口径（2026-11-07 两轮 --resume 实测定死，别改回去）：
        //   顶层 usage 是**整个会话累计**，而且 input_tokens 已经把 cache 并进去了
        //   （恒有 input_tokens === cache_read_input_tokens + cache_creation_input_tokens）。
        //   拿它当「本轮」用会同时犯两个错：随轮次膨胀（界面飙到 1001.2%）、前端再叠加缓存正好翻一倍。
        //   真值在两个地方：
        //     · modelUsage[模型] —— 本轮增量，三个字段互不重叠（0 + 20736 + 4254 = 24990）
        //     · _meta["codebuddy.ai/contextUsed"] —— 当前上下文占用，绝对值，等于 byCategory 各项之和
        const topUsage = (event.usage ?? {}) as Record<string, number>;
        const modelUsage = (event.modelUsage ?? {}) as Record<string, {
          inputTokens?: number; outputTokens?: number;
          cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number;
        }>;
        const perModel = modelUsage[modelId] ?? Object.values(modelUsage)[0];
        const cacheRead = perModel?.cacheReadInputTokens ?? topUsage.cache_read_input_tokens ?? 0;
        const cacheWrite = perModel?.cacheCreationInputTokens ?? topUsage.cache_creation_input_tokens ?? 0;
        // 兜底（无 modelUsage 的老版本 CLI）：顶层 input 含缓存，减掉才是未命中部分。
        const input = perModel ? (perModel.inputTokens ?? 0) : Math.max(0, (topUsage.input_tokens ?? 0) - cacheRead - cacheWrite);
        const output = perModel?.outputTokens ?? topUsage.output_tokens ?? 0;
        // 持久化本轮助手内容与用量（重载后统计与上下文窗口才对得上）
        flushAssistant({
          input, output, cacheRead, cacheWrite, reasoning: 0,
          totalTokens: input + output + cacheRead + cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });
        const modelWindow = perModel?.contextWindow ?? 0;
        const contextWindow = modelWindow > 0 ? modelWindow : modelContextWindow(modelId);
        const ctxUsed = Number(((event._meta ?? {}) as Record<string, unknown>)["codebuddy.ai/contextUsed"] ?? 0);
        const contextTokens = ctxUsed > 0 ? ctxUsed : input + cacheRead + cacheWrite;
        // 重开会话时 sessions.getAgentContext 靠这条还原真实上下文：
        // 只存增量 usage 的话，重开后只能拿到「上一轮增量」，不是完整占用。
        if (ctxUsed > 0 && history) {
          try { history.appendCustomEntry("toonflowContextUsed", { tokens: ctxUsed, contextWindow, at: Date.now() }); } catch { /* 持久化失败不影响运行 */ }
        }
        send({
          type: "stats",
          stats: { tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite } },
          contextUsage: { tokens: contextTokens, contextWindow, percent: Math.min(100, Math.round(contextTokens / contextWindow * 100)) },
        });
        if (turnSessionId && sessionFile) {
          map[sessionFile] = turnSessionId;
          void writeFile(join(cwd, SESSION_MAP), JSON.stringify(map, null, 2), "utf8").catch(() => {});
        }
        settle({
          sessionId: turnSessionId, killedForSteer: false, aborted: false,
          error: (event.is_error || event.subtype !== "success") ? String(event.result || "CodeBuddy 运行失败") : undefined,
        });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handle(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderrBuf += chunk; });
    child.on("error", (error) => settle({ sessionId: turnSessionId, killedForSteer, aborted, error: `无法启动 CodeBuddy：${error.message}` }));
    child.on("close", () => {
      if (settled) return;
      flushAssistant();
      settle({
        sessionId: turnSessionId, killedForSteer, aborted,
        error: killedForSteer || aborted ? undefined : (stderrBuf.trim() ? `CodeBuddy 提前退出：${stderrBuf.trim().slice(0, 500)}` : "CodeBuddy 未返回结果"),
      });
    });

    child.stdin.write(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: turnPrompt }] },
    })}\n`);
    // 单轮模式：写完就关 stdin，别让 CLI 一直等下一条（否则 result 永远不来，卡到超时）。
    child.stdin.end();

    const timer = setTimeout(() => {
      if (!settled) { try { child.kill(); } catch { /* 已退出 */ } settle({ sessionId: turnSessionId, killedForSteer, aborted, error: "CodeBuddy 超时（10 分钟）" }); }
    }, 10 * 60_000);
    const outcome = await done;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    interruptChild = undefined;
    return outcome;
  }

  let turnPrompt = buildPrompt(options, runId);
  let finalError: string | undefined;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const outcome = await runTurn(turnPrompt);
      sessionId = outcome.sessionId || sessionId;
      if (outcome.aborted) break;
      if (outcome.error) { finalError = outcome.error; break; }
      // 插队消息优先：无论本轮是被 steer 杀掉重开的，还是刚好跑完 steer 才入队的，都要先处理它。
      const steer = active?.steer.shift();
      if (steer) { persistUser(steer.prompt); turnPrompt = `${cbMarker}${steerGuidance}${steer.prompt}`; continue; }
      const followUp = active?.followUp.shift();
      if (followUp) { persistUser(followUp.prompt); turnPrompt = `${cbMarker}${followUp.prompt}`; continue; }
      break;
    }
  } finally {
    if (active) activeCodebuddyRuns.delete(active.sessionFile);
    void rm(tempDir, { recursive: true, force: true });
  }
  if (finalError) send({ type: "error", message: finalError });
  send({ type: "done" });
  return { sessionId, runId };
}
