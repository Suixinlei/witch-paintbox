import { el } from "./dom";

export interface Field<T> {
  key: keyof T;
  label: string;
  type?: "text" | "textarea" | "number" | "checkbox" | "json" | "model";
  help?: string;
}
export function form<T extends object>(
  parent: HTMLElement,
  initial: T,
  fields: Field<T>[],
) {
  const controls = new Map<
    keyof T,
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >();
  for (const spec of fields) {
    const label = el("label", spec.label, parent);
    const input =
      spec.type === "textarea" || spec.type === "json"
        ? el("textarea", undefined, parent)
        : spec.type === "model"
          ? el("select", undefined, parent)
          : el("input", undefined, parent);
    input.id = `setting-${String(spec.key)}`;
    label.htmlFor = input.id;
    if (input instanceof HTMLInputElement) {
      input.type =
        spec.type === "number"
          ? "number"
          : spec.type === "checkbox"
            ? "checkbox"
            : "text";
      if (input.type === "checkbox") input.checked = Boolean(initial[spec.key]);
    }
    if (input instanceof HTMLSelectElement)
      for (const [value, title] of [
        ["submodel", "辅助模型"],
        ["model", "主力模型"],
      ]) {
        const option = el("option", title, input);
        option.value = value;
      }
    input.value =
      spec.type === "json"
        ? JSON.stringify(initial[spec.key] ?? null, null, 2)
        : String(initial[spec.key] ?? "");
    if (spec.help) el("small", spec.help, parent);
    controls.set(spec.key, input);
  }
  return {
    read(): T {
      const result = structuredClone(initial);
      for (const spec of fields) {
        const input = controls.get(spec.key);
        if (!input) continue;
        const value: unknown =
          spec.type === "checkbox" && input instanceof HTMLInputElement
            ? input.checked
            : spec.type === "number"
              ? Number(input.value)
              : spec.type === "json"
                ? JSON.parse(input.value)
                : input.value;
        Object.assign(result, { [spec.key]: value });
      }
      return result;
    },
    value(key: keyof T) {
      return controls.get(key)?.value ?? "";
    },
  };
}
