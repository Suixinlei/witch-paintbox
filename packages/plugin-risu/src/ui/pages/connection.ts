import type { UiServices } from "../contracts";
import { button, el } from "../dom";

export function renderConnection(
  main: HTMLElement,
  { generation }: UiServices,
) {
  const { state } = generation;
  el(
    "p",
    "魔女画匣独立服务负责规划、排队和绘图。Risu 将返回的图片挂到对应回复。",
    main,
  );
  const connection = state.paintboxConnection;
  const addressLabel = el("label", "独立服务地址", main);
  const address = el("input", undefined, main);
  address.id = "setting-paintbox-url";
  addressLabel.htmlFor = address.id;
  address.type = "url";
  address.value = connection?.url ?? "http://127.0.0.1:4783";
  const tokenLabel = el("label", "Risu 专用服务令牌", main);
  const token = el("input", undefined, main);
  token.id = "setting-paintbox-token";
  tokenLabel.htmlFor = token.id;
  token.type = "password";
  token.autocomplete = "off";
  token.placeholder = connection
    ? "已保存，留空可复用"
    : "请输入 Risu 专用令牌";
  button(
    main,
    "测试并保存服务连接",
    () =>
      generation.connectPaintbox({
        url: address.value,
        token: token.value || connection?.token || "",
      }),
    state.working,
  );
  el(
    "p",
    "角色卡、服装、模型、画师、Prompt 和配图工作流均在服务管理台设置。",
    main,
  );
  const link = el("a", "打开服务管理台", main);
  link.href = connection?.url ?? "http://127.0.0.1:4783";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
}
