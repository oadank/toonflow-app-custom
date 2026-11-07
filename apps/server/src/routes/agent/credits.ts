import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

// 每轮结束后把余额/消耗落进会话文件，刷新对话时随消息一起读回。
export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/),
  messageId: z.string().min(1).max(200),
  balance: z.number().nullable(),
  runCost: z.number().nullable(),
  unit: z.enum(["cny", "credit"]).optional(),
}), async (req, res) => {
  const { directory, sessionFile, messageId, balance, runCost, unit } = req.body as {
    directory: string; sessionFile: string; messageId: string;
    balance: number | null; runCost: number | null; unit?: "cny" | "credit";
  };
  const { directory: cwd, path } = await u.workspaceFile.resolveWorkspaceFile(req, directory, `.agent/sessions/${sessionFile}`);
  res.json(success(await u.agent.appendAgentCredits(cwd, path, { messageId, balance, runCost, unit })));
});
