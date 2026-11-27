export const text = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const id = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
export const clean = (value = "") =>
  String(value)
    .replace(
      /<(think|thoughts|thinking|analysis|statusData)\b[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<statusData\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<img=[^>]*>/gi, "")
    .trim();
export const statusLabel: Record<string, string> = {
  pending: "等待处理",
  ready: "提示词已保存",
  uncertain: "提交结果待确认",
  preparing: "整理画面",
  submitting: "提交中",
  complete: "已保存",
  error: "失败",
};
