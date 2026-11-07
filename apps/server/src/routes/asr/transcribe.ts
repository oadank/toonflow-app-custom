import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * POST /api/asr/transcribe
 * 本地语音识别代理：接收浏览器录制的音频二进制（application/octet-stream），
 * 落盘后转交本机 sherpa-onnx（SenseVoice）ASR 服务识别，返回纯文本。
 * 走本地服务，不依赖任何外部/浏览器语音识别，离线可用、秒级返回。
 */

const ASR_SERVICE_URL = process.env.ASR_SERVICE_URL || "http://127.0.0.1:18790";
const ASR_TRANSCRIBE = `${ASR_SERVICE_URL}/transcribe`;
const MAX_BYTES = 50_000_000;

function readRawBody(req: import("express").Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error("音频体积超过上限（50MB）"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}

export default Router().post("/", async (req, res) => {
  let tempFile: string | undefined;
  try {
    const body = await readRawBody(req);
    if (!body.length) {
      res.status(400).json({ code: 400, message: "未收到音频数据" });
      return;
    }
    const ext = typeof req.query.ext === "string" && /^[a-z0-9]+$/i.test(req.query.ext) ? req.query.ext.toLowerCase() : "webm";
    const dir = join(tmpdir(), "toonflow-asr");
    await mkdir(dir, { recursive: true });
    tempFile = join(dir, `${randomUUID()}.${ext}`);
    await writeFile(tempFile, body);
    const response = await fetch(ASR_TRANSCRIBE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioPath: tempFile }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.json() as { text?: string; error?: string };
    if (!response.ok) {
      res.status(502).json({ code: 502, message: raw.error || "本地语音识别服务调用失败" });
      return;
    }
    res.json({ code: 200, data: { text: raw.text ?? "" } });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    res.status(status).json({ code: status, message: `语音识别失败：${error instanceof Error ? error.message : String(error)}` });
  } finally {
    if (tempFile) await unlink(tempFile).catch(() => {});
  }
});
