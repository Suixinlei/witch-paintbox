let fieldId = 0;
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  parent?.append(node);
  return node;
}
export function button(
  parent: HTMLElement,
  label: string,
  action: () => void | Promise<unknown>,
  disabled = false,
) {
  const node = el("button", label, parent);
  node.type = "button";
  node.disabled = disabled;
  node.onclick = () => {
    void Promise.resolve(action()).catch((error) => {
      console.error(error);
    });
  };
  return node;
}
export function textarea(parent: HTMLElement, label: string, value: string) {
  const wrapper = el("label", label, parent);
  const input = el("textarea", undefined, parent);
  input.id = `field-${++fieldId}`;
  wrapper.htmlFor = input.id;
  input.value = value;
  return input;
}
export function detail(parent: HTMLElement, title: string, value: unknown) {
  const node = el("details", undefined, parent);
  el("summary", title, node);
  el(
    "pre",
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
    node,
  );
}
