import { ref } from "vue";

export type DeepSeekBalance = { currency: string; total: number; granted: number; toppedUp: number };

export const deepSeekBalance = ref<DeepSeekBalance | null>(null);
export const deepSeekBalanceError = ref("");
let lastFetch = 0;
const TTL = 30_000;

// 只读查本机 Toonflow server 代理的 DeepSeek 官方余额接口，30s 内缓存，避免频繁打 DeepSeek。
export async function refreshDeepSeekBalance(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastFetch < TTL) return;
  lastFetch = now;
  try {
    const response = await fetch("/api/deepseek/balance", { headers: { "x-toonflow-workspace": "1" } });
    const json = await response.json() as { code?: number; data?: DeepSeekBalance };
    if (json?.code === 200 && json.data) {
      deepSeekBalance.value = json.data;
      deepSeekBalanceError.value = "";
    }
  } catch {
    // 静默失败，保留上一次余额
  }
}

/**
 * DeepSeek 官方价目表（元 / 百万 token），口径与 dsh-input-tools 的 balance.js 完全一致：
 * 来源 api-docs.deepseek.com「模型 & 价格」；高峰 = 周一至周五 09:00-12:00、14:00-18:00（不含法定节假日），
 * 其余时段空闲、价格半价。老大按这套算过账，别自己另起价目表。
 */
export const DS_TOKEN_PRICES: Record<string, { peak: { inMiss: number; inHit: number; out: number }; idle: { inMiss: number; inHit: number; out: number } }> = {
  "deepseek-flash": { peak: { inMiss: 2, inHit: 0.04, out: 8 }, idle: { inMiss: 1, inHit: 0.02, out: 4 } },
  "deepseek-v4-flash": { peak: { inMiss: 2, inHit: 0.04, out: 8 }, idle: { inMiss: 1, inHit: 0.02, out: 4 } },
  "deepseek-v4-pro": { peak: { inMiss: 9, inHit: 0.3, out: 27 }, idle: { inMiss: 4.5, inHit: 0.15, out: 13.5 } },
};

/** 当前是否高峰时段（工作日 9-12 / 14-18）。法定节假日无法离线判定，按工作日处理（与 input 插件同口径）。 */
export function dsPeakNow(d = new Date()): boolean {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 按 token 用量算本轮花费（元）。input 是含 cache 的总输入，cacheRead 单独计价。 */
export function deepSeekCostCNY(
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
  modelId = "deepseek-v4-flash",
  peak = dsPeakNow(),
): number | null {
  if (!tokens) return null;
  const table = DS_TOKEN_PRICES[modelId] ?? DS_TOKEN_PRICES["deepseek-v4-flash"];
  const pr = peak ? table.peak : table.idle;
  const input = tokens.input ?? 0;
  const cacheRead = Math.min(tokens.cacheRead ?? 0, input);
  const cacheWrite = tokens.cacheWrite ?? 0;
  const miss = Math.max(0, input - cacheRead);
  const cost = (miss * pr.inMiss + cacheRead * pr.inHit + cacheWrite * pr.inMiss + (tokens.output ?? 0) * pr.out) / 1_000_000;
  return cost;
}
