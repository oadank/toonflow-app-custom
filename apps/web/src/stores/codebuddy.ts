import { ref } from "vue";

/** CodeBuddy 账号余额 / 本轮实扣积分（来自 /api/codebuddy/credits）。 */
export type CodeBuddyCredits = {
  todayUsed: number | null;
  runCost: number | null;
  turns: Array<{ runId: string; at: number; modelId: string; credit: number | null; requests: number }>;
  rate: { model: string; label: string; peak: number; current: number; isPeak: boolean } | null;
  officialBalance: number | null;
  balanceSource: string;
  percent: number | null;
};

export const codebuddyCredits = ref<CodeBuddyCredits | null>(null);
export const codebuddyCreditsError = ref("");
let lastFetch = 0;
const TTL = 30_000;

// 只读查本机 Toonflow server 代理的 CodeBuddy 积分接口（配置中心 official-credits + CLI 会话记录），30s 内缓存。
export async function refreshCodebuddyCredits(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastFetch < TTL) return;
  lastFetch = now;
  try {
    const response = await fetch("/api/codebuddy/credits", { headers: { "x-toonflow-workspace": "1" } });
    const json = await response.json() as { code?: number; data?: CodeBuddyCredits };
    if (json?.code === 200 && json.data) {
      codebuddyCredits.value = json.data;
      codebuddyCreditsError.value = "";
    }
  } catch {
    // 静默失败，保留上一次积分
  }
}
