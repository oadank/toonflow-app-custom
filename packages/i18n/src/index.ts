import { IntlMessageFormat } from "intl-messageformat";
import { escapeMessageText } from "./messageText.ts";
export { escapeMessageText } from "./messageText.ts";

export type Locale = "zh-CN" | "zh-TW" | "en" | "ja" | "ru" | "vi" | "th" | "ko" | "hi"
  | "id" | "ms" | "fil" | "bn" | "ur" | "ta" | "te" | "mr" | "pa" | "ar" | "fa" | "tr";
export interface MessageDescriptor { id: string; values?: Record<string, unknown> }
export const supportedLocales: { code: Locale; name: string }[] = [
  { code: "zh-CN", name: "简体中文" }, { code: "zh-TW", name: "繁體中文" },
  { code: "en", name: "English" }, { code: "ja", name: "日本語" },
  { code: "ru", name: "Русский" }, { code: "vi", name: "Tiếng Việt" },
  { code: "th", name: "ไทย" }, { code: "ko", name: "한국어" }, { code: "hi", name: "हिन्दी" },
  { code: "id", name: "Bahasa Indonesia" }, { code: "ms", name: "Bahasa Melayu" }, { code: "fil", name: "Filipino" },
  { code: "bn", name: "বাংলা" }, { code: "ur", name: "اردو" }, { code: "ta", name: "தமிழ்" },
  { code: "te", name: "తెలుగు" }, { code: "mr", name: "मराठी" }, { code: "pa", name: "ਪੰਜਾਬੀ" },
  { code: "ar", name: "العربية" }, { code: "fa", name: "فارسی" }, { code: "tr", name: "Türkçe" },
];
// [2026-11-10] 语言包改动态 import 按需加载：原静态 import 把 20 种语言 8.66MB 全打进一个 chunk，
// 用户只用自己的语言却要下载全部。动态 import 后每种语言独立 chunk，用时才拉（约 400-600KB）。
// zh-CN（简中）内置为兜底，其余语言首次切换时加载后缓存。
const catalogs: Record<string, Record<string, string>> = { "zh-CN": {} };
const loadedLocales = new Set<string>(["zh-CN"]);
const localeLoaders: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  "zh-TW": () => import("./locales/zhTw.json"),
  "en": () => import("./locales/en.json"),
  "ja": () => import("./locales/ja.json"),
  "ru": () => import("./locales/ru.json"),
  "vi": () => import("./locales/vi.json"),
  "th": () => import("./locales/th.json"),
  "ko": () => import("./locales/ko.json"),
  "hi": () => import("./locales/hi.json"),
  "id": () => import("./locales/id.json"),
  "ms": () => import("./locales/ms.json"),
  "fil": () => import("./locales/fil.json"),
  "bn": () => import("./locales/bn.json"),
  "ur": () => import("./locales/ur.json"),
  "ta": () => import("./locales/ta.json"),
  "te": () => import("./locales/te.json"),
  "mr": () => import("./locales/mr.json"),
  "pa": () => import("./locales/pa.json"),
  "ar": () => import("./locales/ar.json"),
  "fa": () => import("./locales/fa.json"),
  "tr": () => import("./locales/tr.json"),
};
export async function ensureLocaleLoaded(locale: Locale): Promise<boolean> {
  if (loadedLocales.has(locale)) return true;
  const loader = localeLoaders[locale];
  if (!loader) return false;
  try {
    const mod = await loader();
    catalogs[locale] = mod.default;
    loadedLocales.add(locale);
    return true;
  } catch { return false; }
}
let activeLocale: Locale = "zh-CN";
const listeners = new Set<(locale: Locale) => void>();
const formatters = new Map<string, IntlMessageFormat>();

export function normalizeLocale(value: unknown): Locale | undefined {
  if (typeof value !== "string") return;
  let language: Intl.Locale;
  try { language = new Intl.Locale(value.trim().replaceAll("_", "-")); }
  catch { return; }
  const script = language.maximize().script;
  if (language.language === "zh") {
    if (script === "Hans") return "zh-CN";
    if (script === "Hant") return "zh-TW";
    return;
  }
  const base = language.language === "tl" ? "fil" : language.language === "in" ? "id" : language.language;
  const locale = supportedLocales.find(item => item.code === base)?.code;
  // ACT: 每种新增语言只提供一种文字体系；pa-Arab/pa-PK 等不能误用 Gurmukhi 译文。
  return locale && script === new Intl.Locale(locale).maximize().script ? locale : undefined;
}

export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return "en";
}

export function isRtlLocale(locale: Locale): boolean { return ["ar", "fa", "ur"].includes(locale); }

export function getLocale(): Locale { return activeLocale; }
export function setLocale(locale: Locale) {
  if (locale === activeLocale) return;
  activeLocale = locale;
  for (const listener of listeners) listener(locale);
}
export function subscribeLocale(listener: (locale: Locale) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function msg(strings: TemplateStringsArray, ...values: unknown[]): MessageDescriptor {
  if (!values.length) return { id: strings[0] };
  return {
    id: strings.map((part, index) => escapeMessageText(part) + (index < values.length ? `{${index}}` : "")).join(""),
    values: Object.fromEntries(values.map((value, index) => [index, value])),
  };
}

export function translate(message: string | MessageDescriptor, values?: Record<string, unknown>, language: Locale = activeLocale): string {
  const id = typeof message === "string" ? message : message.id;
  const parameters = values ?? (typeof message === "string" ? undefined : message.values);
  const catalog = Object.hasOwn(catalogs, language) ? catalogs[language] : undefined;
  const translated = catalog && Object.hasOwn(catalog, id) && typeof catalog[id] === "string" ? catalog[id] : id;
  if (!parameters || !Object.keys(parameters).length) return translated;
  const format = (text: string) => {
    const cacheKey = `${language}\0${text}`;
    let formatter = formatters.get(cacheKey);
    if (!formatter) {
      formatter = new IntlMessageFormat(text, language, undefined, { ignoreTag: true });
      // ACT: 字典与语言切换共享缓存，限制 2000 项；无需随用户输入增长。
      if (formatters.size >= 2000) formatters.delete(formatters.keys().next().value!);
      formatters.set(cacheKey, formatter);
    }
    const result = formatter.format(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key,
      typeof value === "number" || value instanceof Date ? value : String(value),
    ])));
    return Array.isArray(result) ? result.join("") : String(result);
  };
  try { return format(translated); }
  catch {
    // ACT: 损坏或缺参数的外部语言包回退原文；参数只替换一次，不再解析用户输入。
    try { return format(id); }
    catch { return id.replace(/\{(\d+)\}/g, (token, key) => Object.hasOwn(parameters, key) ? String(parameters[key]) : token); }
  }
}

export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return translate(msg(strings, ...values));
}
