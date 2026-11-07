import { computed, onScopeDispose, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import type xSender from "x-sender";

type VoiceState = "idle" | "recording" | "transcribing";

/**
 * 闪电语音输入：本地 ASR（本机 sherpa-onnx / SenseVoice，经 Toonflow server 代理 /api/asr/transcribe）。
 * 不依赖浏览器或 Google 语音识别服务，离线可用、秒级返回。
 * 录音用 MediaRecorder，停止后把音频发到服务端落盘再交本地 ASR 识别，文本回填到输入框。
 */
export default function useVoiceInput(options: {
  getSender: () => xSender | undefined;
  active: () => boolean;
  disabled: () => boolean;
  locked: () => boolean;
  onStart: () => void;
}) {
  const voiceSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const voiceState = ref<VoiceState>("idle");
  const voiceText = ref("");
  const voiceLevel = ref(0);
  const voiceBars = ref<number[]>([]);
  const voiceActive = computed(() => voiceState.value !== "idle");
  const voiceButtonLabel = computed(() =>
    !voiceSupported
      ? "当前环境无法访问麦克风，无法使用语音输入"
      : voiceActive.value
        ? "正在聆听，点击结束并识别"
        : "闪电语音输入：点击说话，再点结束");

  let mediaStream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let chunks: BlobPart[] = [];
  let voicePress: { pointerId: number; x: number; y: number; timer: number } | undefined;
  let meterRun = 0;
  let meterFrame = 0;
  let meterContext: AudioContext | undefined;
  let cancelled = false;
  let currentInstance: xSender | undefined;
  let currentPosition: ReturnType<xSender["getCurrentNode"]> | undefined;

  // 只停「电平动画」，不碰麦克风轨道。可随时调用。
  function haltMeter() {
    meterRun++;
    cancelAnimationFrame(meterFrame);
    meterFrame = 0;
    voiceLevel.value = 0;
    voiceBars.value = [];
  }

  // 停表 + 释放麦克风。只能在 MediaRecorder 正常 stop（容器收尾）之后调用——
  // 提前停轨道会让 webm 被截断，ffmpeg 解析崩溃（exit 3753488571 / 3199971767）。
  function stopVoiceMeter() {
    haltMeter();
    mediaStream?.getTracks().forEach(track => track.stop());
    mediaStream = undefined;
    const context = meterContext;
    meterContext = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  function startVoiceMeter(stream: MediaStream) {
    // 这里绝不能停 mediaStream 的轨道——它正是刚拿到的新麦克风流。
    // 只清掉上一轮的电平动画与旧 AudioContext。
    haltMeter();
    const prevContext = meterContext;
    meterContext = undefined;
    if (prevContext && prevContext.state !== "closed") void prevContext.close().catch(() => {});
    const run = meterRun;
    try {
      if (typeof AudioContext === "undefined") return;
      const context = new AudioContext();
      meterContext = context;
      if (context.state === "suspended") void context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let lastUpdate = 0;
      function updateLevel(now: number) {
        if (run !== meterRun) return;
        try {
          if (now - lastUpdate >= 1000 / 30) {
            lastUpdate = now;
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
            const rms = Math.sqrt(sum / samples.length);
            const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 0.0001)) + 60) / 48));
            voiceLevel.value = Math.max(level, voiceLevel.value * 0.75);
            const n = 9;
            voiceBars.value = new Array(n).fill(0).map((_, i) =>
              Math.max(0.15, Math.min(1, level * (0.6 + 0.4 * Math.sin(now / 120 + i * 0.7)) + 0.1)));
          }
          meterFrame = requestAnimationFrame(updateLevel);
        } catch {
          stopVoiceMeter();
        }
      }
      meterFrame = requestAnimationFrame(updateLevel);
    } catch {
      stopVoiceMeter();
    }
  }

  function clearVoicePress() {
    if (voicePress) window.clearTimeout(voicePress.timer);
    voicePress = undefined;
  }

  function armVoiceInput(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || options.locked() || !options.active() || options.getSender()?.chatEditor.isComposition ||
      (event.target instanceof Element && event.target.closest("[data-agent-mention]"))) return;
    clearVoicePress();
    voicePress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: window.setTimeout(startVoiceInput, 450) };
  }

  function moveVoicePress(event: PointerEvent) {
    if (voicePress?.pointerId === event.pointerId && !voiceActive.value && Math.hypot(event.clientX - voicePress.x, event.clientY - voicePress.y) > 8) clearVoicePress();
  }

  function releaseVoicePress(event: PointerEvent) {
    if (voicePress?.pointerId === event.pointerId) stopVoiceInput();
  }

  function cleanupRecorder() {
    try { recorder?.stream.getTracks().forEach(track => track.stop()); } catch { /* 已停止 */ }
    recorder = undefined;
    mediaStream = undefined;
  }

  function resetState() {
    voiceState.value = "idle";
    voiceText.value = "";
    stopVoiceMeter();
    cleanupRecorder();
  }

  function cancelVoiceInput(event?: Event) {
    if (event instanceof KeyboardEvent && event.key !== "Escape") return;
    if (event?.type === "visibilitychange" && !document.hidden) return;
    if (event instanceof KeyboardEvent && voiceActive.value) event.preventDefault();
    clearVoicePress();
    cancelled = true;
    haltMeter();
    if (recorder && recorder.state !== "inactive") {
      // 先让 MediaRecorder 正常收尾（onstop → finishTranscribe → resetState 才释放麦克风）。
      // 这里提前停轨道会让 webm 截断，必须避免。
      try { recorder.stop(); } catch { resetState(); }
    } else {
      resetState();
    }
  }

  function stopVoiceInput() {
    clearVoicePress();
    cancelled = false;
    haltMeter();
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { void finishTranscribe(); }
    } else {
      void finishTranscribe();
    }
  }

  async function uploadAudio(blob: Blob): Promise<string> {
    const ext = blob.type.includes("webm") ? "webm"
      : blob.type.includes("ogg") ? "ogg"
      : blob.type.includes("mp4") ? "mp4"
      : blob.type.includes("wav") ? "wav"
      : blob.type.includes("mpeg") ? "mp3"
      : "webm";
    const res = await fetch(`/api/asr/transcribe?ext=${ext}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-toonflow-workspace": "1" },
      body: blob,
    });
    const json = await res.json() as { code?: number; data?: { text?: string }; message?: string };
    if (json?.code === 200 && json.data) return json.data.text ?? "";
    throw new Error(json?.message || `语音识别服务返回 ${res.status}`);
  }

  async function finishTranscribe() {
    const instance = currentInstance;
    const position = currentPosition;
    const mime = recorder?.mimeType || "audio/webm";
    const blob = chunks.length ? new Blob(chunks, { type: mime }) : null;
    chunks = [];
    if (cancelled || !blob) { resetState(); recorder = undefined; return; }
    voiceState.value = "transcribing";
    try {
      const text = await uploadAudio(blob);
      voiceText.value = text;
      if (!text || !instance || options.getSender() !== instance || !options.active() || options.disabled()) return;
      instance.enable();
      const pos = position as { instance?: { $el: HTMLElement; focus: (n: number) => void }; offset?: number } | undefined;
      if (pos?.instance && instance.chatElement.richText.contains(pos.instance.$el)) {
        pos.instance.focus(Math.min(pos.offset ?? 0, pos.instance.$el.textContent?.length ?? 0));
      } else {
        instance.focus("last");
      }
      await instance.setText(text);
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : "语音识别失败");
    } finally {
      resetState();
      recorder = undefined;
    }
  }

  function startVoiceInput() {
    const instance = options.getSender();
    if (!instance || options.locked() || !options.active() || instance.chatEditor.isComposition) return;
    if (!voiceSupported) {
      clearVoicePress();
      ElMessage.warning("当前环境无法访问麦克风，请改用文字输入。");
      return;
    }
    try {
      let position = { ...instance.getCurrentNode() } as ReturnType<xSender["getCurrentNode"]>;
      const selection = window.getSelection();
      if (selection?.focusNode && instance.chatElement.richText.contains(selection.focusNode)) {
        for (const line of instance.chatEditor.NODES) for (const tag of line.children) {
          if ((tag.type !== "Write" && tag.type !== "Input") || !tag.$el.contains(selection.focusNode)) continue;
          const range = document.createRange();
          range.selectNodeContents(tag.$el);
          range.setEnd(selection.focusNode, selection.focusOffset);
          position = { node: selection.focusNode, instance: tag, offset: range.toString().length } as ReturnType<xSender["getCurrentNode"]>;
        }
      }
      currentInstance = instance;
      currentPosition = position;
      cancelled = false;
      chunks = [];
      voiceText.value = "";
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        mediaStream = stream;
        let mimeType = "";
        try {
          mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
        } catch { /* 用默认 */ }
        try {
          recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        } catch (error) {
          cancelVoiceInput();
          ElMessage.warning(error instanceof Error ? `无法启动录音：${error.message}` : "无法启动录音");
          return;
        }
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => { void finishTranscribe(); };
        recorder.start();
        voiceState.value = "recording";
        options.onStart();
        void startVoiceMeter(stream);
      }).catch(error => {
        cancelVoiceInput();
        ElMessage.warning(error instanceof Error ? `无法打开麦克风：${error.message}` : "无法打开麦克风，请检查权限");
      });
    } catch (error) {
      cancelVoiceInput();
      ElMessage.warning(error instanceof Error ? error.message : "无法启动语音输入");
    }
  }

  watch([options.active, options.disabled], ([active, disabled]) => {
    if (!active || disabled) cancelVoiceInput();
  }, { flush: "sync" });
  window.addEventListener("pointermove", moveVoicePress, true);
  window.addEventListener("pointerup", releaseVoicePress, true);
  window.addEventListener("pointercancel", cancelVoiceInput, true);
  window.addEventListener("blur", cancelVoiceInput);
  window.addEventListener("keydown", cancelVoiceInput);
  document.addEventListener("visibilitychange", cancelVoiceInput);
  onScopeDispose(() => {
    cancelVoiceInput();
    window.removeEventListener("pointermove", moveVoicePress, true);
    window.removeEventListener("pointerup", releaseVoicePress, true);
    window.removeEventListener("pointercancel", cancelVoiceInput, true);
    window.removeEventListener("blur", cancelVoiceInput);
    window.removeEventListener("keydown", cancelVoiceInput);
    document.removeEventListener("visibilitychange", cancelVoiceInput);
  });

  return { voiceSupported, voiceState, voiceText, voiceActive, voiceButtonLabel, voiceLevel, voiceBars, armVoiceInput, startVoiceInput, stopVoiceInput, clearVoicePress, cancelVoiceInput };
}
