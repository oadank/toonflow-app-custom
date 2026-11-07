import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const inputSchema = z.object({
  directory: z.string().min(1).max(4096),
  runIds: z.array(z.uuid()).max(1000),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  const { directory, runIds } = req.body as z.infer<typeof inputSchema>;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  // [2026-11-07] 停止生成 = 停掉这个项目里正在跑的一切生成。
  // 画布节点的媒体任务是后台任务，跟 agent 运行没有父子关系；以前只停 agent，
  // 节点那边的 ComfyUI 一直在跑，看着就是「点了停止根本不生效」。
  await Promise.all([
    u.agent.stopAgentRuns(cwd, runIds),
    u.mediaTasks.cancelRunning(cwd).catch(() => []),
  ]);
  res.json(success());
});
