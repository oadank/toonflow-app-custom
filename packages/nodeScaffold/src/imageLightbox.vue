<template>
  <teleport to="body">
    <div v-if="visible" class="imageLightbox" @contextmenu.prevent>
      <!-- 图外区域（stage 空白）：缩小光标，点一下退出 -->
      <div ref="stageEl" class="lbStage" @pointerdown.self="close" @wheel.prevent="onWheel">
        <img
          v-if="kind !== 'video'"
          ref="imgEl"
          class="lbImg"
          :class="{ dragging }"
          :src="src"
          :style="imgStyle"
          draggable="false"
          @load="fit"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
          @mousedown="onMiddleDown"
          @dblclick.stop="toggleFit" />
        <!-- 视频：悬浮窗居中播放（不是浏览器全屏），点外部/中键/Esc 关闭 -->
        <video
          v-else
          class="lbVideo"
          :src="src"
          controls
          autoplay
          playsinline
          @mousedown="onMiddleDown"
          @click.stop />
      </div>
      <button class="lbBtn lbClose" type="button" title="关闭" aria-label="关闭" @click.stop="close">×</button>
      <div v-if="kind !== 'video'" class="lbBar" @pointerdown.stop>
        <button class="lbBtn" type="button" title="缩小" aria-label="缩小" @click="zoomBy(1 / 1.25)">−</button>
        <span class="lbPct">{{ pct }}%</span>
        <button class="lbBtn" type="button" title="放大" aria-label="放大" @click="zoomBy(1.25)">+</button>
        <button class="lbBtn lbText" type="button" @click="resetFit">适应</button>
        <button class="lbBtn lbText" type="button" @click="toOneToOne">1:1</button>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
/**
 * [2026-11-05 老大令] 全屏看图灯箱（自写，替换 el-image-viewer）
 * 为什么不用 element 自带：① 它没有 1:1 真实像素按钮；② 它的 canvas 全屏盖住遮罩，
 * 点图外根本不关闭；③ 中键无法绑定。这三条都是老大明确要的。
 *
 * 交互（对齐 dsh 客户端 ImageLightbox + 8090 预览页，两者手感一致）：
 *   - 鼠标在图外：缩小光标，点一下退出
 *   - 鼠标在图上：抓手，按住拖动平移；松手不动 = 点击 → 适应 ⇄ 1:1 切换
 *   - 中键点图：直接切 1:1（原始像素）
 *   - 滚轮：以鼠标位置为锚点缩放（鼠标下的像素不动）
 *   - Esc 关闭；底部工具条 − / 百分比 / + / 适应 / 1:1；右上角 ×
 * 百分比口径：100% = 适应窗口；「1:1」= 原始像素（可能是 100% 以上，小图时也可能是 100%）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ visible: boolean; src: string; kind?: "image" | "video" }>();
const emit = defineEmits<{ "update:visible": [boolean] }>();

const stageEl = ref<HTMLElement>();
const imgEl = ref<HTMLImageElement>();
const s = ref(1);
const tx = ref(0);
const ty = ref(0);
const fitK = ref(1); // 显示尺寸 / 原始像素，用于让 1:1 是真实像素口径
const dragging = ref(false);

const pct = computed(() => Math.round(s.value * 100));
const imgStyle = computed(() => ({
  transform: `translate(-50%, -50%) translate(${tx.value}px, ${ty.value}px) scale(${s.value})`,
}));

function apply() {
  /* 百分比与缩放都靠响应式驱动，无需手动改 style */
}

function fit() {
  const el = imgEl.value;
  if (!el) return;
  const nw = el.naturalWidth || 1;
  const nh = el.naturalHeight || 1;
  const ratio = Math.min(((window.innerWidth * 0.94) / nw), ((window.innerHeight - 120) / nh), 1);
  fitK.value = ratio || 1;
  el.style.width = `${Math.round(nw * ratio)}px`;
  el.style.height = `${Math.round(nh * ratio)}px`;
  s.value = 1;
  tx.value = 0;
  ty.value = 0;
}

function resetFit() {
  s.value = 1;
  tx.value = 0;
  ty.value = 0;
}

/** 原始像素：让显示尺寸 = naturalWidth */
function toOneToOne() {
  const target = fitK.value > 0 ? 1 / fitK.value : 1;
  zoomAt(target);
}

function toggleFit() {
  if (Math.abs(s.value - 1 / fitK.value) < 0.03) resetFit();
  else toOneToOne();
}

function zoomAt(next: number, clientX?: number, clientY?: number) {
  const stage = stageEl.value;
  const ns = Math.min(12, Math.max(0.05, next));
  if (!stage) {
    s.value = ns;
    return;
  }
  const r = stage.getBoundingClientRect();
  const mx = (clientX === undefined ? r.left + r.width / 2 : clientX) - r.left - r.width / 2;
  const my = (clientY === undefined ? r.top + r.height / 2 : clientY) - r.top - r.height / 2;
  const k = ns / s.value;
  tx.value = mx * (1 - k) + tx.value * k;
  ty.value = my * (1 - k) + ty.value * k;
  s.value = ns;
}

function zoomBy(factor: number) {
  zoomAt(s.value * factor);
}

function onWheel(e: WheelEvent) {
  const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
  zoomAt(s.value * factor, e.clientX, e.clientY);
}

// ---- 拖动 + 点击判定（移动超过 6px 算拖动，不触发切换）----
let start = { x: 0, y: 0, tx: 0, ty: 0 };
let moved = false;

/** [2026-11-05 老大令] 中键点图 = 关闭（打开靠中键点节点缩略图）。不用 .middle 修饰符，手判更稳。 */
function onMiddleDown(e: MouseEvent) {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  close();
}

function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  start = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value };
  moved = false;
  dragging.value = true;
}

function onMove(e: PointerEvent) {
  if (!dragging.value) return;
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  if (Math.hypot(dx, dy) > 6) moved = true;
  tx.value = start.tx + dx;
  ty.value = start.ty + dy;
}

function onUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  if (!moved) toggleFit(); // 松手没动 = 点击
}

function close() {
  emit("update:visible", false);
}

function onKey(e: KeyboardEvent) {
  if (!props.visible) return;
  if (e.key === "Escape") close();
  if (e.key === "+" || e.key === "=") zoomBy(1.25);
  if (e.key === "-" || e.key === "_") zoomBy(1 / 1.25);
  if (e.key === "0") resetFit();
}

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    const el = imgEl.value;
    if (el?.complete && el.naturalWidth > 0) fit();
  },
  { flush: "post" },
);

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<style scoped lang="scss">
.imageLightbox {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgb(8 10 14 / 94%);
  user-select: none;
}

.lbStage {
  position: absolute;
  inset: 0;
  display: block;
  /* 图外 = 缩小光标：点一下退出 */
  cursor: zoom-out;
}

.lbImg {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  max-height: none;
  transform-origin: center center;
  will-change: transform;
  cursor: grab;
  touch-action: none;

  &.dragging {
    cursor: grabbing;
  }
}

/* 视频：悬浮窗居中，不铺满屏幕 */
.lbVideo {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: min(1200px, 90vw);
  max-height: 82vh;
  border-radius: 10px;
  background: #000;
  cursor: default;
}

.lbBtn {
  border: 0;
  background: rgb(255 255 255 / 12%);
  color: #fff;
  border-radius: 8px;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;

  &:hover {
    background: rgb(255 255 255 / 22%);
  }
}

.lbClose {
  position: absolute;
  top: 24px;
  right: 24px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 22px;
  z-index: 2;
}

.lbBar {
  position: absolute;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgb(255 255 255 / 10%);
  z-index: 2;

  .lbBtn {
    width: 32px;
    height: 32px;
  }

  .lbText {
    width: auto;
    padding: 0 12px;
    font-size: 13px;
  }
}

.lbPct {
  min-width: 52px;
  color: #fff;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
</style>
