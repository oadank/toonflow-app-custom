<template>
  <div class="creditBar">
    <el-text size="small">账号余额 <strong>{{ balanceText }}</strong></el-text>
    <el-text size="small" type="info">今日已用 {{ todayText }}</el-text>
    <el-text size="small" type="info">{{ rateText }}</el-text>
    <el-button text size="small" :loading="loading" @click="load()">刷新</el-button>
    <el-text v-if="info.offline" size="small" type="warning">{{ info.message }}</el-text>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import axios from "axios";

type CreditInfo = {
  todayUsed: number | null;
  runCost: number | null;
  officialBalance: number | null;
  percent: number | null;
  rate: { label: string; peak: number; current: number; isPeak: boolean } | null;
  offline: boolean;
  message?: string;
};

const info = ref<CreditInfo>({
  todayUsed: null, runCost: null, officialBalance: null,
  percent: null, rate: null, offline: false,
});
const loading = ref(false);
const balanceText = computed(() => info.value.officialBalance === null ? "—" : `${Number(info.value.officialBalance).toFixed(2)} 分`);
const todayText = computed(() => info.value.todayUsed === null ? "—" : `${info.value.todayUsed} 分（${info.value.percent ?? 0}%）`);
const rateText = computed(() => {
  const rate = info.value.rate;
  return rate ? `${rate.label} ${rate.isPeak ? "高峰" : "闲时"} x${rate.current}` : "";
});

async function load() {
  loading.value = true;
  try {
    const { data } = await axios.get("/api/codebuddy/credits", { timeout: 30000 });
    if (data.code === 200) info.value = data.data as CreditInfo;
  } catch (error) {
    info.value = { ...info.value, offline: true, message: error instanceof Error ? error.message : "请求失败" };
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<style lang="scss" scoped>
.creditBar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
</style>
