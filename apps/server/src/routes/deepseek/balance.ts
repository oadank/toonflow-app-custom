import { Router } from "express";
import { readFileSync } from "node:fs";

/**
 * GET /api/deepseek/balance
 * 只读调 DeepSeek 官方余额接口，返回当前账号余额（CNY）。
 * 用 main 模型在 litellm 配置里的真实 DeepSeek key；也可经环境变量 DEEPSEEK_API_KEY 覆盖。
 * 不消耗、不触发任何生成，安全。
 */

const LITELLM_CONFIG = "C:\\D\\opt\\litellm\\venv\\litellm_config.yaml";
let cache: { at: number; data: { currency: string; total: number; granted: number; toppedUp: number } } | null = null;
const TTL = 30_000;

function getDeepSeekKey(): string | undefined {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  try {
    const text = readFileSync(LITELLM_CONFIG, "utf8");
    const idx = text.indexOf("model_name: main");
    if (idx >= 0) {
      const tail = text.slice(idx, idx + 800);
      const match = tail.match(/api_key:\s*([^\s]+)/);
      if (match) return match[1];
    }
  } catch { /* 配置读不到就走 env / 报错 */ }
  return undefined;
}

export default Router().get("/", async (_req, res) => {
  if (cache && Date.now() - cache.at < TTL) {
    res.json({ code: 200, data: cache.data });
    return;
  }
  const key = getDeepSeekKey();
  if (!key) {
    res.status(500).json({ code: 500, message: "未找到 DeepSeek API Key（请设置环境变量 DEEPSEEK_API_KEY 或在 litellm 配置 main 模型里配置）" });
    return;
  }
  try {
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.json() as { balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }> };
    const info = raw.balance_infos?.[0];
    if (!info) {
      res.status(502).json({ code: 502, message: "DeepSeek 余额接口返回异常", raw });
      return;
    }
    const data = {
      currency: info.currency ?? "CNY",
      total: Number(info.total_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
    };
    cache = { at: Date.now(), data };
    res.json({ code: 200, data });
  } catch (error) {
    res.status(502).json({ code: 502, message: `查询 DeepSeek 余额失败：${error instanceof Error ? error.message : String(error)}` });
  }
});
