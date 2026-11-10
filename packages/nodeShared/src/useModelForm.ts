import { computed, watch, type Ref } from "vue";
import formCreate, { type Rule } from "@form-create/element-ui";
import { findNodeModel, type NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";

export function useModelForm(data: Ref<{ model: string; other: Record<string, unknown> }>, model: Ref<NodeMediaModel | undefined>) {
  let previousModel = data.value.model;

  watch([() => data.value.model, model], ([modelKey, selectedModel]) => {
    const sameModel = selectedModel && findNodeModel([selectedModel], previousModel);
    const values = modelKey === previousModel || sameModel ? data.value.other : {};
    previousModel = modelKey;
    if (!selectedModel) {
      if (values !== data.value.other) data.value.other = values;
      return;
    }
    data.value.other = getModelFormValues(selectedModel, values);
  }, { immediate: true, flush: "sync" });
}

export function getModelFormValues(model: NodeMediaModel, values: Record<string, unknown>, updates: Record<string, unknown> = {}) {
  const fields = new Map<string, unknown>();
  collectFields(formCreate.copyRules(model.rules ?? []), fields);
  for (const field of Object.keys(updates)) {
    if (!fields.has(field)) throw new Error(`当前模型不支持自定义配置 ${field}，请查看 getConfig 返回的模型 rules`);
  }
  const nextValues = { ...values, ...updates };
  return Object.fromEntries([...fields].map(([field, value]) => [field, Object.hasOwn(nextValues, field) ? nextValues[field] : value]));
}

export function useImageModelForm(data: Ref<{ model: string; other: Record<string, unknown>; size: string; ratio: string }>, model: Ref<NodeMediaModel | undefined>) {
  useModelForm(data, model);
  const sizeOptions = computed(() => model.value?.imageSizes?.length ? model.value.imageSizes : ["2K"]);
  const ratioOptions = computed(() => model.value?.imageRatios?.length ? model.value.imageRatios : ["16:9"]);
  watch(model, choice => {
    if (!choice) return;
    // ACT: 现有分辨率使用 K 单位；出现其他单位时再统一换算，未知名称排在数值选项之后。
    // [2026-11-05 本机定制] 改成「按数组顺序取第一个」：数组首项就是平台推荐的默认档，
    // 比按数字猜更可控（例如 qwen 编辑把 2K 写在最前面做默认，按数字排会掉到 1K）。
    if (!sizeOptions.value.includes(data.value.size)) data.value.size = sizeOptions.value[0]!;
    if (!ratioOptions.value.includes(data.value.ratio)) data.value.ratio = ratioOptions.value.includes("16:9") ? "16:9" : ratioOptions.value[0]!;
    // [2026-11-05 本机定制] 配了 sizeRatios 的模型：尺寸是主控，比例必须跟着尺寸走，
    // 避免 AI 设出「2048x1536 + 3:2」这种不存在的组合。
    const mappedRatio = (choice as { sizeRatios?: Record<string, string> }).sizeRatios?.[data.value.size];
    if (mappedRatio) data.value.ratio = mappedRatio;
  }, { flush: "sync" });
  return { sizeOptions, ratioOptions };
}

function collectFields(rules: unknown, fields: Map<string, unknown>) {
  if (!Array.isArray(rules)) return;
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const item = rule as Rule;
    if (typeof item.field === "string") fields.set(item.field, item.value);
    collectFields(item.children, fields);
    if (Array.isArray(item.control)) {
      for (const control of item.control) collectFields(control?.rule, fields);
    }
  }
}
