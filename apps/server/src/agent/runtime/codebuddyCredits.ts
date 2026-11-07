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
  const cached = cache.get(run.sessionId);
  if (cached && Date.now() - run.at > 5 * 60_000) return cached.value;
  const file = await findTranscript(run.sessionId, run.startedAt);
  if (!file) return base;
  let info;
  try { info = await stat(file); } catch { return base; }
  if (cached && cached.mtime === info.mtimeMs) return cached.value;
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { return base; }

  const perRequest = new Map<string, { credit: number; original: number }>();
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
    // 同一 conversationRequestId 可能被多条路径重复上报：只取 max，且 0 不覆盖真值。
    const key = String(row.providerData?.conversationRequestId || row.id || Math.random());
    const prev = perRequest.get(key);
    const safeCredit = Number.isFinite(credit) ? credit : 0;
    const safeOriginal = Number.isFinite(original) ? original : 0;
    if (!prev || safeCredit > prev.credit) {
      perRequest.set(key, { credit: safeCredit, original: Math.max(prev?.original ?? 0, safeOriginal) });
    }
  }
  if (!found) return base;
  let credit = 0;
  let original = 0;
  for (const item of perRequest.values()) { credit += item.credit; original += item.original; }
  const value: CodeBuddyRunCredit = {
    ...base,
    credit: Math.round(credit * 1e6) / 1e6,
    originalCredit: Math.round(original * 1e6) / 1e6,
    requests: perRequest.size,
    source: "cli-transcript",
  };
  cache.set(run.sessionId, { at: Date.now(), mtime: info.mtimeMs, value });
  return value;
}

export async function summarizeCodebuddyRuns(limit = 12): Promise<CodeBuddyRunCredit[]> {
  return Promise.all(getCodebuddyRuns().slice(0, limit).map(compute));
}
