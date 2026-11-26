import { expect, test } from "@playwright/test";

test("service mode keeps one navigation and delegates configuration to the service", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route("**/e2e-paintbox/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    if (path.endsWith("/health"))
      return route.fulfill({ json: { version: 3, revision: "configured" } });
    if (path.endsWith("/risu/preferences"))
      return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/e2e/fixture/");
  await page.evaluate(() =>
    window.harness.configure({ execution: "paintbox", enabled: false }),
  );
  await page.reload();
  await page
    .getByLabel("Risu 专用服务令牌")
    .fill("fixture-consumer-token-0000");
  await page.getByRole("button", { name: "测试并保存服务连接" }).click();
  await expect(page.getByRole("navigation")).toHaveCount(1);
  await expect(page.getByRole("navigation").getByRole("button")).toHaveText([
    "服务连接",
    "配图",
    "生图回顾",
  ]);
  await expect(
    page.getByRole("link", { name: "服务管理台 ↗" }),
  ).toHaveAttribute("href", "http://127.0.0.1:4783");
  await expect(
    page.getByRole("link", { name: "打开服务管理台", exact: true }),
  ).toHaveAttribute("target", "_blank");
  await expect(page.getByLabel("服务管理员令牌", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Risu 角色卡", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "配图", exact: true }).click();
  await expect(page.getByRole("navigation")).toHaveCount(1);
  expect(
    requested.some(
      (path) => path.includes("/admin/") || path.endsWith("/config"),
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
});
