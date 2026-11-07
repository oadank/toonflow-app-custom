import { Router } from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import {
  clearCodebuddyKey,
  codebuddyKeyView,
  currentCodebuddyKey,
  fetchCodebuddyAccount,
  maskKey,
  restorePreviousCodebuddyKey,
  saveCodebuddyKey,
} from "@/utils/codebuddyKey";

/**
 * CodeBuddy 账号（API Key）设置接口 —— 2026-11-07 老大要的「设置里能填、自动进环境变量、不回显、能测」。
 *
 * 安全约定：任何响应都不带明文 key，最多 `ck_…后4位`。
 * 有效性判定：能查到账号 Uin + 积分余额 = 通过；401 = key 无效/过期。
 */

const router = Router();

const keySchema = z.string().trim().min(10, "API Key 太短，请检查是否复制完整").max(500, "API Key 太长");

/** GET /api/codebuddy/account —— 当前配置状态（脱敏） */
router.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store").json(success(codebuddyKeyView()));
});

/**
 * POST /api/codebuddy/account/test —— 测试 key（可带新 key，不传就用当前生效的）
 * 只读官方账单接口，不消耗积分、不改任何配置。
 */
router.post("/test", async (req, res) => {
  const parsed = z.object({ key: keySchema.optional() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(error(parsed.error.issues[0]?.message ?? "参数错误"));
    return;
  }
  const key = parsed.data.key?.trim() || currentCodebuddyKey();
  if (!key) {
    res.status(400).json(error("还没有可用的 API Key，请先填写"));
    return;
  }
  try {
    const account = await fetchCodebuddyAccount(key);
    res.set("Cache-Control", "no-store").json(success({ ok: true, maskedKey: maskKey(key), account }));
  } catch (cause) {
    res.status(400).json(error(cause instanceof Error ? cause.message : "测试失败"));
  }
});

/**
 * POST /api/codebuddy/account/save —— 保存 key（先测通再存，测不通不许存）
 * body.writeSystem=false 时只写 Toonflow 自己，不动 Windows 用户级环境变量。
 */
router.post("/save", async (req, res) => {
  const parsed = z.object({ key: keySchema, writeSystem: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(error(parsed.error.issues[0]?.message ?? "参数错误"));
    return;
  }
  const key = parsed.data.key.trim();
  try {
    // 先把关：拿不到账号和余额就不许存，避免存个坏 key 把 agent 弄哑
    const account = await fetchCodebuddyAccount(key);
    const result = saveCodebuddyKey(key, { writeUserEnv: parsed.data.writeSystem !== false });
    res.json(success({ ok: true, maskedKey: maskKey(key), account, ...result, state: codebuddyKeyView() }));
  } catch (cause) {
    res.status(400).json(error(cause instanceof Error ? cause.message : "保存失败"));
  }
});

/** POST /api/codebuddy/account/restore —— 还原成覆盖前的用户级 Key */
router.post("/restore", (_req, res) => {
  try {
    restorePreviousCodebuddyKey();
    res.json(success({ ok: true, state: codebuddyKeyView() }));
  } catch (cause) {
    res.status(400).json(error(cause instanceof Error ? cause.message : "还原失败"));
  }
});

/** DELETE /api/codebuddy/account —— 清除设置页保存的 key（有旧值就还回去） */
router.delete("/", (_req, res) => {
  try {
    const result = clearCodebuddyKey();
    res.json(success({ ok: true, ...result, state: codebuddyKeyView() }));
  } catch (cause) {
    res.status(500).json(error(cause instanceof Error ? cause.message : "清除失败"));
  }
});

export default router;
