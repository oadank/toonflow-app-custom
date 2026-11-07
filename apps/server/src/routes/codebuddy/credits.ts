import { Router } from "express";
import https from "node:https";
import { success } from "@/lib/responseFormat";
import { summarizeCodebuddyRuns } from "@/agent/runtime/codebuddyCredits";

/**
 * 积分数据源：全部本机 / 官方直连，**不经过 CEO 看板 lecoo.tailb5f10f.ts.net**。
 *  - 余额：配置中心 :13600 的 official-credits.ts（它直连 codebuddy.cn billing）；
 *  - 今日已用：wb-credits :3470 的 credits_window（官方 billing 明细按日）；
 *  - 每轮实扣：codebuddy CLI 会话记录 providerData.rawUsage.credit（零延迟）。
 *
 * 🔴 不调 model_rates：它底层走 /api/ceo-model，看板一下线这条就挂，
 *    而且静态产品配置里的倍率（x0.03）跟实际套餐（x0.11）对不上，显示出来是错数。
 *    设置页也不再摆那张倍率大表。
 */

const MCP_URL = "http://127.0.0.1:3470/mcp";

/**
 * 账号额度模型倍率：老大 2026-11-06 拍板口径，本机常量。
 * 高峰 = 周一至周五 9-12 / 14-18 原价，其余闲时半价（Dsv4.1f 闲时 = 0.11 的一半 = 0.055）。
 * 🔴 不拉 /api/ceo-model，也不读客户端静态产品配置（那里 dsv4.1f 写着 x0.03，是过期默认值）。
 */
const MODEL_RATES: Record<string, { label: string; peak: number }> = {
  "hy3": { label: "Hy3", peak: 0 },
  "glm-5.3-flash": { label: "Glm5.3f", peak: 0.08 },
  "deepseek-v4.1-flash": { label: "Dsv4.1f", peak: 0.11 },
  "step-5-preview": { label: "Step5", peak: 0.33 },
};

function isPeakHours(d = new Date()) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function currentRate(modelId: string) {
  const item = MODEL_RATES[modelId] ?? MODEL_RATES["deepseek-v4.1-flash"]!;
  const peak = isPeakHours();
  return { model: modelId, label: item.label, peak: item.peak, current: peak ? item.peak : item.peak / 2, isPeak: peak };
}

async function callMcp(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find(item => item.startsWith("data: "));
  if (!line) throw new Error("wb-credits 返回格式异常");
  const payload = JSON.parse(line.slice(6)) as {
    error?: { message?: string };
    result?: { content?: { text?: string }[] };
  };
  if (payload.error) throw new Error(payload.error.message || "wb-credits 调用失败");
  return (payload.result?.content ?? []).map(item => item.text ?? "").join("\n");
}

function totalOf(text: string) {
  const match = text.match(/合计\s*([\d.]+)\s*分/);
  return match ? Number(match[1]) : null;
}

/** 官方账号余额（积分）：配置中心 official-credits.ts 口径，HTTPS 自签证书。 */
async function fetchOfficialBalance(): Promise<number | null> {
  const url = process.env.TOONFLOW_BALANCE_URL || "https://127.0.0.1:13600/api/agents/workbuddy/status";
  return new Promise((resolve) => {
    try {
      const req = https.get(url, { rejectUnauthorized: false, timeout: 8000 }, (res) => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body) as { balance?: { total?: string } };
            const value = Number(json.balance?.total);
            resolve(Number.isFinite(value) ? value : null);
          } catch { resolve(null); }
        });
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    } catch { resolve(null); }
  });
}

export default Router().get("/", async (_req, res) => {
  try {
    const today = new Date();
    const start = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-") + " 00:00:00";
    const [windowText, officialBalance] = await Promise.all([
      callMcp("credits_window", { start, group_by: "none" }),
      fetchOfficialBalance(),
    ]);
    const todayUsed = totalOf(windowText);
    const turns = await summarizeCodebuddyRuns();
    const runCost = turns[0]?.credit ?? null;
    res.set("Cache-Control", "no-store").json(success({
      todayUsed, runCost, turns,
      rate: currentRate(turns[0]?.modelId ?? "deepseek-v4.1-flash"),
      officialBalance,
      balanceSource: officialBalance === null ? "unavailable" : "config-center/official-credits",
      percent: todayUsed === null || officialBalance === null
        ? null : Math.min(100, Math.round(todayUsed / Math.max(1, todayUsed + officialBalance) * 100)),
      offline: false,
    }));
  } catch (e) {
    res.set("Cache-Control", "no-store").json(success({
      todayUsed: null, runCost: null, turns: [], rate: null,
      officialBalance: null, balanceSource: "unavailable",
      percent: null, offline: true,
      message: e instanceof Error ? e.message : "积分服务不可用",
    }));
  }
});
