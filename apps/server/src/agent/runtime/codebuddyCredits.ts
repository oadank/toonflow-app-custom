import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { getCodebuddyRuns, type CodeBuddyRunRecord } from "./codebuddy";

/**
 * 每轮真实积分：直接读 codebuddy CLI 会话记录里的 providerData.rawUsage.credit。
 *
 * 照抄的是本机两套跑通的老代码，不是自己发明：
 *  - 旧版 wb-shim daemon.mjs:279 recordCredit：`usage.credit` 直出、按 stepId 去重取 max、
 *    credit=0 不锁表（真值后到要能覆盖）、convId = 官方账 requestId。
 *  - 现在版本 dsh-input-tools/lib/balance.js:1271 findSessionFile：先按 sessionId 精确找，
 *    找不到退回最近修改的会话文件（两级策略）。
 *  - openmem 33e1f751：归一化 usage 没有 credit，只有原始 rawUsage 有；
 *    db60b01a：conversationRequestId 就是官方账 requestId，不用按时间窗猜。
 *
 * 🔴 不套 balance.js 的 DS_TOKEN_PRICES（那是 DeepSeek 官方直连按 token 算「人民币」，
 *    且 workbuddy-models 技能明说「不要把 token 数乘倍率当结论」）。这里要的是账号积分，
 *    CLI 自己已经给了实扣值，零延迟，不用等官方账 1~3 分钟。
 *    本地实时值长轮可能与官方账差 3% 左右，界面要注明「以官方账为准」。
 *
 * 🔴 2026-11-07 修正（老大报「后台都是好几份，界面一直是 0.几分」）：
 *    同一个 conversationRequestId 下的多条 rawUsage **不是重复上报，是同一轮的多次模型调用**
 *    （每次工具调用返回后都要再请求一次模型），必须求和；旧代码按 requestId 取 max，
 *    永远只拿到第一跳的 0.几。实测对齐（会话 01a1b190…，2026-11-07）：
 *      requestId 01a1b47433ec7d829bed → 8 行求和 3.30 = 官方账单 13:21 的 3.30
 *      requestId 01a1b47534527be8a3eb → 4 行求和 1.58 = 官方 13:22 的 1.58
 *      requestId 01a1b477b80d7a69bd96 → 9 行求和 2.58 = 官方 13:25 的 2.58
 *    行级去重靠 transcript 每行的唯一 `id`（同轮 24 行 = 24 个不同 id，确认不是重复上报）。
 */

export type CodeBuddyRunCredit = {
  runId: string;
  at: number;
  modelId: string;
  credit: number | null;
  originalCredit: number | null;
  requests: number;
  source: "cli-transcript" | "pending";
};

const cache = new Map<string, { at: number; mtime: number; value: CodeBuddyRunCredit }>();

/** 与 codebuddy.ts cleanEnv 的 CODEBUDDY_CONFIG_DIR 保持同一份：服务端是 LocalSystem，homedir() 指不到老大的 CLI 配置目录。 */
function transcriptRoot() {
  const home = process.env.TOONFLOW_CODEBUDDY_HOME || "C:\\Users\\oadan";
  const configDir = process.env.TOONFLOW_CODEBUDDY_CONFIG_DIR || join(home, ".codebuddy");
  return join(configDir, "projects");
}

async function findTranscript(sessionId: string, startedAt: number) {
  const root = transcriptRoot();
  let entries: string[] = [];
  try { entries = await readdir(root); } catch { return ""; }
  let fallback = "";
  let fallbackTime = 0;
  for (const dir of entries) {
    const sub = join(root, dir);
    let files: string[] = [];
    try { files = await readdir(sub); } catch { continue; }
    const exact = files.find(file => file === `${sessionId}.jsonl`);
    if (exact) return join(sub, exact);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(sub, file);
      try {
        const info = await stat(path);
        if (info.mtimeMs >= startedAt - 5000 && info.mtimeMs > fallbackTime) {
          fallbackTime = info.mtimeMs;
          fallback = path;
        }
      } catch { /* 单文件读不到跳过 */ }
    }
  }
  return fallback;
}

type TranscriptRow = {
  id?: string;
  timestamp?: number;
  providerData?: {
    conversationRequestId?: string;
    rawUsage?: Record<string, unknown>;
  };
};

async function compute(run: CodeBuddyRunRecord): Promise<CodeBuddyRunCredit> {
  const base: CodeBuddyRunCredit = {
    runId: run.runId, at: run.at, modelId: run.modelId,
    credit: null, originalCredit: null, requests: 0, source: "pending",
  };
  // 老轮次账已定型，别每 30 秒重新扫盘。
  // 🔴 cache 必须按 run 分开：同一 session 会有多轮 run（每轮都 unshift 一条），
  //    只按 sessionId 缓存会让后几轮直接复用第一轮的数（也是「一直显示 0.几」的帮凶）。
  const cacheKey = `${run.sessionId}:${run.runId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - run.at > 5 * 60_000) return cached.value;
  const file = await findTranscript(run.sessionId, run.startedAt);
  if (!file) return base;
  let info;
  try { info = await stat(file); } catch { return base; }
  if (cached && cached.mtime === info.mtimeMs) return cached.value;
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { return base; }

  const perRequest = new Map<string, { credit: number; original: number; calls: number }>();
  const seenLines = new Set<string>();
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes('"rawUsage"')) continue;
    let row: TranscriptRow;
    try { row = JSON.parse(line) as TranscriptRow; } catch { continue; }
    const raw = row.providerData?.rawUsage;
    if (!raw) continue;
    if (typeof row.timestamp === "number" && row.timestamp < run.startedAt - 5000) continue;
    const credit = Number(raw.credit);
    const original = Number(raw.original_credit);
    if (!Number.isFinite(credit) && !Number.isFinite(original)) continue;
    found = true;
    // 同一 conversationRequestId 下有多条：是同一轮的多跳模型调用，**求和**，不是去重取 max。
    // 真重复上报按行 id 去重（transcript 每行 id 唯一）。
    const lineKey = String(row.id || `${row.timestamp ?? ""}|${credit}|${original}`);
    if (seenLines.has(lineKey)) continue;
    seenLines.add(lineKey);
    const key = String(row.providerData?.conversationRequestId || row.id || Math.random());
    const prev = perRequest.get(key) ?? { credit: 0, original: 0, calls: 0 };
    perRequest.set(key, {
      credit: prev.credit + (Number.isFinite(credit) ? credit : 0),
      original: prev.original + (Number.isFinite(original) ? original : 0),
      calls: prev.calls + 1,
    });
  }
  if (!found) return base;
  let credit = 0;
  let original = 0;
  let requests = 0;
  for (const item of perRequest.values()) {
    credit += item.credit;
    original += item.original;
    requests += item.calls;
  }
  const value: CodeBuddyRunCredit = {
    ...base,
    credit: Math.round(credit * 1e6) / 1e6,
    originalCredit: Math.round(original * 1e6) / 1e6,
    requests,
    source: "cli-transcript",
  };
  cache.set(cacheKey, { at: Date.now(), mtime: info.mtimeMs, value });
  return value;
}

export async function summarizeCodebuddyRuns(limit = 12): Promise<CodeBuddyRunCredit[]> {
  return Promise.all(getCodebuddyRuns().slice(0, limit).map(compute));
}
