import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * CodeBuddy API Key（`CODEBUDDY_API_KEY`，ck_ 开头）的托管层。
 *
 * 为什么需要它：Toonflow 的 agent 引擎是外挂的 codebuddy CLI，认证全靠这个环境变量。
 * 之前只能去系统环境变量里手工加/改，换人换账号就得手工折腾，所以做成设置页可填。
 *
 * 三条铁律（2026-11-07 老大定）：
 *  1. **界面不回显**：接口只返回「是否已配置 + ck_…后4位」，明文永不出服务端；
 *  2. **留空不覆盖**：只有用户显式提交新值才改，什么都不填就当没这回事；
 *  3. **保存前先测**：用新 key 直连官方账单接口，拿得到账号 Uin + 积分余额才算通过，测不过不许存。
 *
 * 生效路径（两处，都写）：
 *  - 落盘 `data/secrets/codebuddy-key.json`：服务重启后自动装回；
 *  - 注入当前进程 `process.env`：codebuddy.ts 的 cleanEnv 会继承给 CLI 子进程，无需重启；
 *  - 同时写 Windows **用户级**环境变量（HKCU\Environment），让新起的 CLI / 其他工具也能用。
 *    覆盖前把旧值存进同一个文件，界面上可一键还原。
 */

const ENV_NAME = "CODEBUDDY_API_KEY";
const FILE_NAME = "codebuddy-key.json";
const API_BASE = "https://www.codebuddy.cn";
const KEY_PATTERN = /^[A-Za-z0-9_\-.+/=]+$/;

export type StoredCodebuddyKey = {
  key: string;
  updatedAt: number;
  /** 覆盖前 Windows 用户级环境变量的旧值；用于「还原」 */
  previousUserKey?: string;
  /** 上次保存时是否同步写了用户级环境变量 */
  wroteUserEnv?: boolean;
};

export type CodebuddyPackage = { name: string; remain: number; cycleEnd: string };

export type CodebuddyAccountInfo = {
  uin: string;
  maskedUin: string;
  /** 剩余积分合计（各资源包剩余数相加，与配置中心 official-credits 同一口径） */
  balance: number;
  packages: CodebuddyPackage[];
  productName: string;
  totalPackages: number;
  checkedAt: number;
};

function dataDir() {
  return process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
}

function secretFile() {
  return join(dataDir(), "secrets", FILE_NAME);
}

function readStored(): StoredCodebuddyKey | null {
  try {
    const text = readFileSync(secretFile(), "utf8");
    const parsed = JSON.parse(text) as StoredCodebuddyKey;
    return typeof parsed?.key === "string" && parsed.key ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(value: StoredCodebuddyKey) {
  const file = secretFile();
  mkdirSync(join(dataDir(), "secrets"), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  try { statSync(file); } catch { /* 忽略权限设置失败 */ }
}

/** 只露头尾，永不返回明文：ck_abcd…wxyz */
export function maskKey(key: string) {
  if (!key) return "";
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function maskUin(uin: string) {
  if (!uin) return "";
  if (uin.length <= 6) return uin;
  return `${uin.slice(0, 4)}****${uin.slice(-4)}`;
}

/** 读 Windows 用户级环境变量（HKCU\Environment），读不到返回空串。 */
function readUserEnv(): string {
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", ENV_NAME], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    // reg 输出可能带 UTF-16 空白，按 REG_SZ 后取值
    const match = out.match(/REG_SZ\s+(\S+)/);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** 写/删 Windows 用户级环境变量。值只允许 key 字符集，避免命令行转义问题。 */
function writeUserEnv(value: string | null): boolean {
  if (process.platform !== "win32") return false;
  try {
    if (!value) {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", ENV_NAME, "/f"], {
        encoding: "utf8", windowsHide: true, timeout: 5000, stdio: "ignore",
      });
      return true;
    }
    if (!KEY_PATTERN.test(value)) return false;
    execFileSync("reg", ["add", "HKCU\\Environment", "/v", ENV_NAME, "/t", "REG_SZ", "/d", value, "/f"], {
      encoding: "utf8", windowsHide: true, timeout: 5000, stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** 服务启动时调用：把落盘的 key 装进进程环境（优先于系统环境变量）。 */
export function loadCodebuddyKey() {
  const stored = readStored();
  if (stored?.key) {
    process.env[ENV_NAME] = stored.key;
    console.log(`[codebuddy-key] 已加载设置页保存的 API Key（${maskKey(stored.key)}）`);
    return { source: "settings" as const };
  }
  if (process.env[ENV_NAME]) {
    console.log(`[codebuddy-key] 使用环境变量里的 API Key（${maskKey(process.env[ENV_NAME]!)}）`);
    return { source: "env" as const };
  }
  const userKey = readUserEnv();
  if (userKey) {
    process.env[ENV_NAME] = userKey;
    console.log(`[codebuddy-key] 使用用户级环境变量里的 API Key（${maskKey(userKey)}）`);
    return { source: "user-env" as const };
  }
  console.log("[codebuddy-key] 未配置 API Key，CodeBuddy 引擎的 agent 可能无法认证");
  return { source: "none" as const };
}

/** 给设置页看的脱敏视图（不含明文）。 */
export function codebuddyKeyView() {
  const stored = readStored();
  const envKey = process.env[ENV_NAME] ?? "";
  const userKey = readUserEnv();
  const effective = stored?.key || envKey || userKey;
  const source = stored?.key ? "settings" : envKey ? "process-env" : userKey ? "user-env" : "none";
  return {
    configured: !!effective,
    masked: effective ? maskKey(effective) : "",
    source,
    updatedAt: stored?.updatedAt ?? null,
    /** 用户级环境变量里现在是什么（脱敏），便于确认「已写入系统」 */
    systemEnv: userKey ? maskKey(userKey) : "",
    systemEnvMatches: !!(userKey && effective && userKey === effective),
    /** 是否存有旧值可还原 */
    canRestorePrevious: !!stored?.previousUserKey,
  };
}

/**
 * 用指定 key 直连官方账单接口，验证有效性并取账号信息。
 * 只读、不消耗积分；401 直接判为「key 无效或已过期」。
 */
export async function fetchCodebuddyAccount(key: string): Promise<CodebuddyAccountInfo> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API Key 为空");
  if (!KEY_PATTERN.test(trimmed)) throw new Error("API Key 含非法字符（应为一串 ck_ 开头的字母数字）");

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ PageNumber: 1, PageSize: 200, ProductCode: "p_tcaca", Status: [0, 3] }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error(`连不上 CodeBuddy 官方接口：${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("API Key 无效或已过期（官方返回 401）");
  }
  if (!response.ok) throw new Error(`官方接口返回 HTTP ${response.status}`);

  const json = (await response.json().catch(() => null)) as {
    code?: number;
    msg?: string;
    data?: { Response?: { Data?: { Accounts?: Record<string, unknown>[]; TotalCount?: number } } };
  } | null;
  if (!json || json.code !== 0) throw new Error(`官方接口返回异常：${json?.msg ?? "空响应"}`);

  const data = json.data?.Response?.Data;
  const accounts = Array.isArray(data?.Accounts) ? data!.Accounts! : [];
  if (!accounts.length) throw new Error("该 Key 查不到任何账号资源包（可能是子账号或无权限）");

  const num = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  let balance = 0;
  const packages: CodebuddyPackage[] = [];
  for (const item of accounts) {
    if (!item || typeof item !== "object") continue;
    let remain = num(item.CycleCapacityRemainPrecise);
    if (!remain) remain = num(item.CycleCapacityRemain);
    if (!remain) remain = num(item.CapacityRemainPrecise);
    if (!remain) remain = num(item.CapacityRemain);
    if (remain < 0) remain = 0;
    balance += remain;
    if (remain > 0) {
      packages.push({
        name: String(item.PackageName || item.SubProductName || "资源包"),
        remain: Math.round(remain * 1e6) / 1e6,
        cycleEnd: String(item.CycleEndTime || item.ExpiredTime || ""),
      });
    }
  }
  packages.sort((a, b) => b.remain - a.remain);

  const first = accounts[0] ?? {};
  const uin = String(first.Uin || first.AccountId || "");
  return {
    uin,
    maskedUin: maskUin(uin),
    balance: Math.round(balance * 1e6) / 1e6,
    packages: packages.slice(0, 5),
    productName: String(first.ProductName || "CodeBuddy"),
    totalPackages: accounts.length,
    checkedAt: Date.now(),
  };
}

export type SaveCodebuddyKeyOptions = { writeUserEnv?: boolean };

/** 保存 key：先测通（调用方负责），再落盘 + 注入进程 + 可选写用户级环境变量。 */
export function saveCodebuddyKey(key: string, options: SaveCodebuddyKeyOptions = {}) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API Key 为空");
  if (!KEY_PATTERN.test(trimmed)) throw new Error("API Key 含非法字符（应为一串 ck_ 开头的字母数字）");

  const currentUserKey = readUserEnv();
  const stored = readStored();
  // 旧值备份：只有真的要覆盖一个不同的用户级值时，才记下它
  const previousUserKey = currentUserKey && currentUserKey !== trimmed
    ? (stored?.key === trimmed ? stored?.previousUserKey || currentUserKey : currentUserKey)
    : stored?.previousUserKey;

  const writeSystem = options.writeUserEnv !== false;
  const wroteUserEnv = writeSystem ? writeUserEnv(trimmed) : false;

  writeStored({
    key: trimmed,
    updatedAt: Date.now(),
    previousUserKey: previousUserKey && previousUserKey !== trimmed ? previousUserKey : undefined,
    wroteUserEnv,
  });
  process.env[ENV_NAME] = trimmed;
  console.log(`[codebuddy-key] 已保存 API Key（${maskKey(trimmed)}）${wroteUserEnv ? "，已写入用户级环境变量" : ""}`);
  return { wroteUserEnv, canRestorePrevious: !!previousUserKey };
}

/** 清除设置页保存的 key；有旧值就还回用户级环境变量，没有就删掉用户级变量。 */
export function clearCodebuddyKey() {
  const stored = readStored();
  if (stored) {
    rmSync(secretFile(), { force: true });
    if (stored.wroteUserEnv) {
      if (stored.previousUserKey) writeUserEnv(stored.previousUserKey);
      else writeUserEnv(null);
    }
    if (process.env[ENV_NAME] === stored.key) delete process.env[ENV_NAME];
    console.log("[codebuddy-key] 已清除设置页保存的 API Key");
  }
  const userKey = readUserEnv();
  if (!process.env[ENV_NAME] && userKey) process.env[ENV_NAME] = userKey;
  return { cleared: !!stored };
}

/** 一键还原：把覆盖前的用户级旧值写回去（并清掉设置页存的 key）。 */
export function restorePreviousCodebuddyKey() {
  const stored = readStored();
  if (!stored?.previousUserKey) throw new Error("没有可还原的旧 Key");
  writeUserEnv(stored.previousUserKey);
  rmSync(secretFile(), { force: true });
  process.env[ENV_NAME] = stored.previousUserKey;
  console.log(`[codebuddy-key] 已还原为覆盖前的 Key（${maskKey(stored.previousUserKey)}）`);
  return { restored: true };
}

export function hasStoredCodebuddyKey() {
  return !!readStored()?.key;
}

export function currentCodebuddyKey() {
  return readStored()?.key || process.env[ENV_NAME] || readUserEnv();
}

export function codebuddySecretPath() {
  return existsSync(secretFile()) ? secretFile() : "";
}
