<template>
  <nodeSkeleton v-bind="nodeProps" :topVisible="node.selected" topWidth="max-content"
    :downloadUrl="previewUrl || ''" :downloadName="outputName">
    <template #topActions>
      <el-button :icon="IconArrowsJoin" text :loading="working" :disabled="!canMerge" @click.stop="merge">合并</el-button>
    </template>
    <div class="mergeBox nopan">
      <div class="insertBar">
        <el-button class="insertFront" size="small" text type="primary"
          :disabled="slotsTotal >= MAX_SLOTS" @click.stop="insertBefore(0)">＋ 在开头插入一段</el-button>
      </div>
      <div class="slotList">
        <div v-for="s in connectedSlots" :key="s.idx" class="slotRow">
          <span class="slotIdx">{{ s.idx }}</span>
          <span class="slotName" :title="s.title">{{ s.name }}</span>
          <el-button class="slotInsert" size="small" text :disabled="slotsTotal >= MAX_SLOTS"
            title="在这段前面插入" @click.stop="insertBefore(s.idx - 1)">＋</el-button>
        </div>
        <div v-if="!connectedSlots.length" class="slotEmpty">还没有连接视频</div>
      </div>
      <div class="sumLine">
        已连接 <b>{{ connectedSlots.length }}</b> 段<span v-if="emptyCount"> · 还有 {{ emptyCount }} 个空位</span>
      </div>
      <el-button class="mergeBtn" type="primary" size="small" :loading="working" :disabled="!canMerge" @click.stop="merge">
        {{ working ? '合并中…' : `合并这 ${readyList.length} 段` }}
      </el-button>
      <el-progress v-if="working" :percentage="100" :indeterminate="true" :duration="2" :show-text="false" />
      <div v-if="error" class="errText">{{ error }}</div>
      <div v-if="previewUrl" class="okLine">✓ 合并完成：{{ outputName }}</div>
      <video v-if="previewUrl" class="previewBox" :src="previewUrl" controls />
      <div v-if="previewUrl" class="outActions">
        <el-button type="success" size="small" plain @click.stop="download">下载成片</el-button>
        <el-button size="small" plain @click.stop="openFolder">打开文件夹</el-button>
      </div>
      <div class="tipLine">按 1→2→3 顺序硬切拼接；规格不一致会自动统一重编码</div>
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { IconArrowsJoin } from "@tabler/icons-vue";
import { ElButton, ElProgress, ElMessage } from "element-plus";
import { useVueFlow } from "@vue-flow/core";
import { nodeSkeleton, useNode, useNodeInputs, useNodeFfmpeg, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";

defineOptions({
  inheritAttrs: false,
  icon: IconArrowsJoin,
  // 初始只给 3 个输入口 —— 20 个口会把节点在画布上撑得很长。
  // 接满了由 ensureHandles() 自动 +2，直到 20 个（只增不减，不会丢已有连接）。
  handles: [
    { id: "in1", type: "target", dataType: "VIDEO", label: "第1段" },
    { id: "in2", type: "target", dataType: "VIDEO", label: "第2段" },
    { id: "in3", type: "target", dataType: "VIDEO", label: "第3段" },
    { id: "video", type: "source", dataType: "VIDEO", label: "合并输出" },
  ] satisfies NodeHandle[],
});

const MAX_SLOTS = 20;
const { id, node, nodeProps, outputs, files, ffmpeg, handles, updateNodeInternals } = useNode({ label: "视频合并" });
const { edges, setEdges, findNode } = useVueFlow();
const inputs = useNodeInputs();
const working = ref(false);
const error = ref("");
const merged = ref<{ url: string; mimeType: string } | undefined>();

const SLOTS = [
  "in1", "in2", "in3", "in4", "in5", "in6", "in7", "in8", "in9", "in10",
  "in11", "in12", "in13", "in14", "in15", "in16", "in17", "in18", "in19", "in20",
];

const slotNames = computed(() => SLOTS.map(s => {
  const list = inputs.getTargetValues(id, s);
  const url = (list[0]?.value as any)?.url;
  // 优先显示上游节点的名字（如「G01 视频生成」），一眼能分清谁接在哪
  const edge = edges.value.find(e => e.target === id && e.targetHandle === s);
  const src = edge?.source ? findNode(edge.source) : undefined;
  const label = (src as any)?.data?.label ?? (src as any)?.label;
  const file = url ? String(url).split(/[\\/]/).at(-1) ?? "" : "";
  return { name: label || file, title: file };
}));
/** 只渲染已连接的段，空位汇总成一行提示 —— 否则 20 行把按钮顶出可视区 */
const connectedSlots = computed(() =>
  slotNames.value.map((item, i) => ({ idx: i + 1, ...item })).filter(s => s.name)
);
const emptyCount = computed(() => Math.max(0, slotsTotal.value - connectedSlots.value.length));

/** 当前实际存在的输入口数量 */
const slotsTotal = computed(() => handles.value.filter(h => h.type === "target").length);
/** 其中已经接了视频的数量 */
const filledCount = computed(() =>
  Array.from({ length: slotsTotal.value }, (_, i) => `in${i + 1}`)
    .filter(hid => inputs.getTargetValues(id, hid).length > 0).length
);

/** 画布上已经接进本节点的最大端口序号（edge 可能指向还不存在的口，必须补出来，否则线会消失） */
const maxEdgeSlot = computed(() => {
  const list = edges.value.filter(e => e.target === id && /^in\d+$/.test(String(e.targetHandle || "")));
  return list.reduce((m, e) => Math.max(m, parseInt(String(e.targetHandle).slice(2)) || 0), 0);
});

/** 需要几个口：至少覆盖已有连接；接满了再多给 2 个空位 */
function desiredSlots() {
  const total = slotsTotal.value;
  const need = Math.max(3, maxEdgeSlot.value);
  if (filledCount.value >= total && total < MAX_SLOTS) return Math.min(MAX_SLOTS, Math.max(need, total + 2));
  return Math.min(MAX_SLOTS, need);
}

/** 只增不减地补齐端口 —— 已有连接不会因为端口被删而断开 */
function syncHandles() {
  const need = desiredSlots();
  const total = slotsTotal.value;
  if (need <= total) return;
  for (let i = total + 1; i <= need; i++) {
    handles.value.push({ id: `in${i}`, type: "target", dataType: "VIDEO", label: `第${i}段` });
  }
  updateNodeInternals();
}
watch([maxEdgeSlot, filledCount], () => nextTick(syncHandles), { immediate: true, flush: "post" });

/**
 * 在指定位置前面插入一段。
 * pos 为 0-based：把编号 > pos 的输入口整体后移一位，腾出 pos+1 号给新段。
 * 同步重排连线的 targetHandle，否则连线会丢失。
 */
function insertBefore(pos: number) {
  const nums = handles.value
    .filter(h => h.type === "target")
    .map(h => parseInt(h.id.slice(2)))
    .filter(n => !Number.isNaN(n));
  const maxN = nums.length ? Math.max(...nums) : 0;
  if (maxN >= MAX_SLOTS) {
    ElMessage.warning(`最多 ${MAX_SLOTS} 段`);
    return;
  }
  const newHandles: NodeHandle[] = handles.value.map(h => {
    if (h.type !== "target") return { ...h };
    const n = parseInt(h.id.slice(2));
    return n > pos ? { ...h, id: `in${n + 1}`, label: `第${n + 1}段` } : { ...h };
  });
  newHandles.push({ id: `in${pos + 1}`, type: "target", dataType: "VIDEO", label: `第${pos + 1}段` });
  // nodeSkeleton 是按 handles 数组顺序渲染端口的：必须按端口编号升序排，
  // 新段才会出现在最前；source 口保持最后。
  newHandles.sort((a, b) => {
    if (a.type === "target" && b.type === "target") return parseInt(a.id.slice(2)) - parseInt(b.id.slice(2));
    if (a.type === "target") return -1;
    if (b.type === "target") return 1;
    return 0;
  });
  handles.value = newHandles;
  setEdges(edges.value.map(e => {
    if (e.target === id && /^in\d+$/.test(String(e.targetHandle ?? ""))) {
      const n = parseInt(String(e.targetHandle).slice(2));
      if (n > pos) return { ...e, targetHandle: `in${n + 1}` };
    }
    return e;
  }));
  updateNodeInternals();
}

const readyList = computed(() => SLOTS
  .map(s => (inputs.getTargetValues(id, s)[0]?.value as any)?.url)
  .filter(Boolean)
  .map(url => String(url)));
const canMerge = computed(() => readyList.value.length >= 2 && !working.value);

// [2026-11-05 老大令] 合并完成后重开画布，预览要还在。
// 原来 merged 只在内存里，重开就空 → 预览没了（outputs.video 其实已经持久化）。
// 现在以 outputs.video 兜底：内存有就用内存（刚合完，最新），否则用已存下来的成片。
const mergedSource = computed<{ url: string; mimeType: string } | undefined>(() => {
  const saved = (outputs.value as any)?.video?.value;
  return merged.value ?? (saved?.url ? { url: String(saved.url), mimeType: String(saved.mimeType || "video/mp4") } : undefined);
});

const outputName = computed(() => mergedSource.value?.url.split(/[\\/]/).at(-1));

const previewUrl = files.useFileUrl(mergedSource as any, (e: unknown) => {
  error.value = String((e as any)?.message || e);
});

function download() {
  const url: any = (previewUrl as any)?.value ?? previewUrl;
  if (!url) return;
  const name = outputName.value || "merged.mp4";
  const a = document.createElement("a");
  a.href = String(url);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  ElMessage.success(`已开始下载：${name}`);
}

/** 在系统文件管理器里定位合并成片 */
async function openFolder() {
  const url = mergedSource.value?.url;
  if (!url) return;
  try {
    const api: any = files.getWorkspaceFiles();
    if (typeof api?.reveal !== "function") {
      ElMessage.warning("当前环境不支持打开文件夹，请用「下载成片」");
      return;
    }
    await api.reveal(String(url));
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  }
}

function runCommand(command: any, out: string) {
  return new Promise<void>((resolve, reject) => {
    command.output(out)
      .on("error", (e: any) => reject(new Error(String(e?.message || e))))
      .on("end", () => resolve())
      .run();
  });
}

async function merge() {
  const list = readyList.value;
  if (list.length < 2) { error.value = "至少连接 2 段视频"; return; }
  working.value = true;
  error.value = "";
  try {
    const out = `merged_${Date.now()}.mp4`;
    // 🔴 ffmpeg() 返回的是「工厂」，再调一次才是命令对象（factory() 无参 = 不带输入）
    const factory: any = await ffmpeg();
    const command: any = factory(list[0]);
    for (const src of list.slice(1)) command.addInput(src);
    // 🔴 必须跟 Toonflow 出片同规格：H3 原生 960×544@24fps 经 RIFE 2x + 放大 2x 已是
    // 1920×1088@48fps。早期版本这里写死 960×544/24，等于把高清片降质重编码（老大抓到）。
    const W = 1920, H = 1088, FPS = 48;
    const filters: string[] = [];
    list.forEach((_, i) => {
      filters.push(`[${i}:v]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},setsar=1[v${i}]`);
      filters.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    });
    filters.push(`${list.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${list.length}:v=1:a=1[outv][outa]`);
    command
      .complexFilter(filters)
      .outputOptions("-map", "[outv]", "-map", "[outa]")
      .videoCodec("libx264")
      .outputOptions("-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p")
      .audioCodec("aac")
      .audioBitrate("192k")
      .outputOptions("-movflags", "+faststart");
    await runCommand(command, out);
    merged.value = { url: out, mimeType: "video/mp4" };
    (outputs.value as any).video = { dataType: "VIDEO", value: { url: out, mimeType: "video/mp4" } };
    ElMessage.success(`合并完成：${out}`);
  } catch (e: any) {
    error.value = String(e?.message || e);
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.mergeBox { display: flex; flex-direction: column; gap: 4px; padding: 8px; min-width: 0; }
/* 只有列表滚动，按钮/预览永远在可视区，节点也不会被 20 行撑高 */
.slotList { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; overflow-x: hidden; }
.slotEmpty { font-size: 11px; color: #6b7280; padding: 4px 0; }
.sumLine { font-size: 11px; color: #9ca3af; }
.slotRow { display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 16px; }
.slotIdx { width: 16px; height: 16px; border-radius: 50%; background: #7c3aed22; color: #a78bfa; display: flex; align-items: center; justify-content: center; font-size: 10px; flex: none; }
.slotRow { width: 100%; min-width: 0; }
.slotName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0; }
.slotList { min-width: 0; }
.slotName.empty { color: #6b7280; }
.errText { color: #f87171; font-size: 12px; word-break: break-all; }
.mergeBtn { width: 100%; margin-top: 4px; }
.outActions { display: flex; gap: 6px; margin-top: 4px; }
.outActions .el-button { flex: 1; margin: 0; }
.okLine { font-size: 11px; color: #34d399; word-break: break-all; }
.previewBox { width: 100%; border-radius: 6px; margin-top: 4px; }
.tipLine { color: #6b7280; font-size: 11px; margin-top: 2px; }

/* 插入段：顶部常驻入口 + 每段 hover 出现的前插按钮 */
.insertBar { display: flex; margin-bottom: 2px; }
.insertFront { padding: 2px 4px; }
.slotInsert { flex: none; margin-left: auto; padding: 0 4px; opacity: 0; transition: opacity .12s; font-size: 14px; }
.slotRow:hover .slotInsert { opacity: 1; }
.slotInsert:disabled, .slotInsert.is-disabled { opacity: 0 !important; }
</style>
