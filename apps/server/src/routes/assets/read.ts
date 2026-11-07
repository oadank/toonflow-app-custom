import { lstat } from "@toonflow/file";
import { sendFile } from "@/utils/fileHttp";
import { basename } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

const router = Router();

export default router.get("/", validateFields({ path: z.string().min(1).max(4096), download: z.literal("true").optional() }, "query"), async (req, res, next) => {
  const root = await u.assets.getAssetsDirectory();
  // [2026-11-04 修] 前端传的路径本身就带 assets/ 前缀，而 root 已经是资产根目录，
  // 直接拼会变成 assets/assets/... → ENOENT（页面显示「读取失败 / Network Error」）。
  // 先把开头多余的 assets/ 去掉再解析。
  const rawPath = String(req.query.path ?? "").replace(/^[\/]*assets[\/]+/i, "");
  const { directory, path } = await u.workspaceFile.resolveWorkspacePath(root, rawPath || String(req.query.path ?? ""));
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  if (!(await lstat(path)).isFile()) throw Object.assign(new Error("只能读取文件"), { status: 400 });
  if (req.query.download === "true") res.attachment(basename(path));
  res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
  await sendFile(res, path, { dotfiles: "allow" }, err => { if (err) next(err); });
});
