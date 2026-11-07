<template>
  <el-card class="cbAccount" shadow="never">
    <div class="cbHeader">
      <div class="cbTitle">
        <el-text tag="strong">CodeBuddy 账号</el-text>
        <el-text size="small" type="info">agent 引擎靠这个 Key 认证；保存后自动进环境变量，无需重启</el-text>
      </div>
      <div class="cbHeaderActions">
        <el-button
          tag="a"
          href="https://www.workbuddy.cn/profile/keys"
          target="_blank"
          rel="noopener noreferrer"
          text
          type="primary"
          size="small"
          :icon="IconExternalLink">去申请访问密钥</el-button>
        <el-tag size="small" effect="plain" :type="state.configured ? 'success' : 'warning'">
          {{ state.configured ? `已配置 ${state.masked}` : "未配置" }}
        </el-tag>
      </div>
    </div>

    <div class="cbRow">
      <el-input
        v-model="newKey"
        class="cbInput"
        type="password"
        autocomplete="new-password"
        show-password
        clearable
        :placeholder="inputPlaceholder"
        :disabled="busy"
        @keyup.enter="save" />
      <el-button :loading="testing" :disabled="busy" @click="test">测试</el-button>
      <el-button type="primary" :loading="saving" :disabled="busy || !newKey.trim()" @click="save">保存</el-button>
    </div>

    <div class="cbMeta">
      <el-text size="small" type="info">来源：{{ sourceText }}</el-text>
      <el-text v-if="state.systemEnv" size="small" :type="state.systemEnvMatches ? 'success' : 'warning'">
        系统用户变量：{{ state.systemEnv }}{{ state.systemEnvMatches ? "（一致）" : "（与当前不一致）" }}
      </el-text>
      <el-checkbox v-model="writeSystem" size="small" :disabled="busy">同时写入 Windows 用户级环境变量（和其他工具共用同一本账号）</el-checkbox>
    </div>

    <el-alert
      v-if="result"
      class="cbResult"
      :type="result.ok ? 'success' : 'error'"
      :closable="false"
      show-icon>
      <template v-if="result.ok && result.account">
        <div class="cbResultLine"><strong>测试通过</strong> · Key <code>{{ result.maskedKey }}</code></div>
        <div class="cbResultLine">账号 <strong>{{ result.account.maskedUin }}</strong>（Uin {{ result.account.uin }}）· {{ result.account.productName }}</div>
        <div class="cbResultLine">
          积分余额 <strong>{{ formatBalance(result.account.balance) }} 分</strong>
          · 资源包 {{ result.account.totalPackages }} 个
        </div>
        <div v-if="result.account.packages.length" class="cbPackages">
          <span v-for="item in result.account.packages" :key="item.name + item.cycleEnd" class="cbPackage">
            {{ item.name }} · 剩 {{ formatBalance(item.remain) }}<template v-if="item.cycleEnd"> · 至 {{ item.cycleEnd.slice(0, 10) }}</template>
          </span>
        </div>
      </template>
      <template v-else>{{ result.message }}</template>
    </el-alert>

    <div class="cbFooter">
      <el-button v-if="state.configured" text type="danger" size="small" :disabled="busy" @click="clear">清除保存的 Key</el-button>
      <el-text size="small" type="info">{{ hintText }}</el-text>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import { IconExternalLink } from "@tabler/icons-vue";

type AccountInfo = {
  uin: string;
  maskedUin: string;
  balance: number;
  productName: string;
  totalPackages: number;
  packages: { name: string; remain: number; cycleEnd: string }[];
};

type KeyState = {
  configured: boolean;
  masked: string;
  source: "settings" | "process-env" | "user-env" | "none";
  updatedAt: number | null;
  systemEnv: string;
  systemEnvMatches: boolean;
  canRestorePrevious: boolean;
};

type TestResult = {
  ok: boolean;
  maskedKey?: string;
  account?: AccountInfo;
  message?: string;
};

const state = ref<KeyState>({
  configured: false, masked: "", source: "none", updatedAt: null,
  systemEnv: "", systemEnvMatches: false, canRestorePrevious: false,
});
const newKey = ref("");
const writeSystem = ref(true);
const testing = ref(false);
const saving = ref(false);
const busy = computed(() => testing.value || saving.value);
const result = ref<TestResult | null>(null);

const sourceText = computed(() => ({
  settings: "本设置页保存",
  "process-env": "服务进程环境变量",
  "user-env": "Windows 用户级环境变量",
  none: "未配置",
}[state.value.source]));

// 🔴 输入框永远不回显已存的 Key：留空 = 不改动
const inputPlaceholder = computed(() => state.value.configured
  ? `已配置 ${state.value.masked}，留空则保持不变；填入新 Key 才会覆盖`
  : "粘贴 CodeBuddy API Key（ck_ 开头）");

const hintText = computed(() => {
  if (!state.value.configured) return "填 Key 后点「测试」，能查到账号和积分余额才算通过";
  if (state.value.systemEnvMatches) return "与系统环境变量里的 Key 是同一本账号，改这里两边一起变";
  return "保存后新开的对话立即生效，正在跑的对话不受影响";
});

function formatBalance(value: number) {
  return Number(value ?? 0).toFixed(2).replace(/\.00$/, "");
}

function fail(cause: unknown) {
  result.value = { ok: false, message: cause instanceof Error ? cause.message : "请求失败" };
}

function apiError(error: unknown) {
  const data = (error as { response?: { data?: { message?: string } } })?.response?.data;
  return new Error(data?.message || (error instanceof Error ? error.message : "请求失败"));
}

async function loadState() {
  try {
    const { data } = await axios.get("/api/codebuddy/account", { timeout: 10000 });
    if (data.code === 200) state.value = data.data as KeyState;
  } catch (error) {
    fail(apiError(error));
  }
}

async function test() {
  testing.value = true;
  result.value = null;
  try {
    const payload = newKey.value.trim() ? { key: newKey.value.trim() } : {};
    const { data } = await axios.post("/api/codebuddy/account/test", payload, { timeout: 30000 });
    result.value = data.code === 200 ? (data.data as TestResult) : { ok: false, message: data.message };
  } catch (error) {
    fail(apiError(error));
  } finally {
    testing.value = false;
  }
}

async function save() {
  const key = newKey.value.trim();
  if (!key) return;
  saving.value = true;
  result.value = null;
  try {
    const { data } = await axios.post("/api/codebuddy/account/save", { key, writeSystem: writeSystem.value }, { timeout: 30000 });
    if (data.code !== 200) throw new Error(data.message || "保存失败");
    result.value = { ok: true, maskedKey: data.data.maskedKey, account: data.data.account as AccountInfo };
    state.value = data.data.state as KeyState;
    newKey.value = "";
    ElMessage.success("已保存并生效");
  } catch (error) {
    fail(apiError(error));
  } finally {
    saving.value = false;
  }
}

async function clear() {
  try {
    await ElMessageBox.confirm("清除后 CodeBuddy 引擎将读回系统环境变量里的 Key，确定？", "清除 API Key", {
      confirmButtonText: "清除", cancelButtonText: "取消", type: "warning",
    });
  } catch { return; }
  try {
    const { data } = await axios.delete("/api/codebuddy/account", { timeout: 15000 });
    if (data.code !== 200) throw new Error(data.message || "清除失败");
    state.value = data.data.state as KeyState;
    result.value = null;
    ElMessage.success("已清除");
  } catch (error) {
    fail(apiError(error));
  }
}

onMounted(() => void loadState());
</script>

<style lang="scss" scoped>
.cbAccount {
  margin-bottom: 12px;

  .cbHeader {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .cbTitle {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .cbHeaderActions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .cbRow {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .cbInput {
    flex: 1 1 auto;
    min-width: 0;
  }

  .cbMeta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 16px;
    margin-top: 8px;
  }

  .cbResult {
    margin-top: 10px;

    .cbResultLine {
      line-height: 1.7;
    }

    code {
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--el-fill-color);
      font-size: 12px;
    }
  }

  .cbPackages {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .cbFooter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
}
</style>
