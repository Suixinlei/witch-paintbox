import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { novelAIPreset } from "../src/shared/novelAIPreset";
async function open(page: Page) {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.seedLibrary());
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.open("library"));
}

test("人物服装表单可增删编辑、选择默认服装，保存后保持外观独立", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "服装管理", exact: true }).click();
  await page
    .getByRole("button", { name: "新增人物专属服装", exact: true })
    .click();
  await page.getByLabel("专属服装名称 1", { exact: true }).fill("兔女郎");
  await page.getByText("服装标识", { exact: true }).click();
  await page.getByLabel("专属服装 ID 1", { exact: true }).fill("private:bunny");
  await page
    .getByLabel("专属服装描述 1", { exact: true })
    .fill(
      "Black bunny suit, black pantyhose, neck bow tie and two wrist bows.",
    );
  await page
    .getByRole("combobox", { name: "默认服装", exact: true })
    .selectOption("private:bunny");
  await page.getByRole("button", { name: "保存资料修改", exact: true }).click();
  await expect(page.locator("#status")).toContainText("手动编辑已保存");
  const saved = await page.evaluate(() => window.harness.snapshot());
  const library = JSON.parse(saved.files["library-char-A"]);
  expect(library.people[0]).toMatchObject({
    appearance: "SAVED_APPEARANCE",
    defaultOutfitId: "private:bunny",
    outfits: [{ id: "private:bunny", name: "兔女郎" }],
  });
  await page.reload();
  await page.evaluate(() => window.harness.open("library"));
  await page.getByRole("button", { name: "服装管理", exact: true }).click();
  await expect(page.getByLabel("专属服装描述 1", { exact: true })).toHaveValue(
    /two wrist bows/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("person-outfits-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "移除专属服装 1", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "默认服装", exact: true }),
  ).toHaveValue("");
  await expect(page.getByLabel("外观描述", { exact: true })).toHaveValue(
    "SAVED_APPEARANCE",
  );
});

test("独立测试设置持久化，预览不提交，服装草稿可直接测试并查看图片", async ({
  page,
}) => {
  await open(page);
  const before = await page.evaluate(() => window.harness.snapshot());
  await page.getByRole("button", { name: "抽取设置", exact: true }).click();
  await page
    .getByLabel("服装测试负向提示词", { exact: true })
    .fill("TEST_NEGATIVE");
  await page
    .getByRole("button", { name: "保存服装测试设置", exact: true })
    .click();
  await expect(page.locator("#status")).toContainText("服装测试设置已保存");
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();

  await page
    .getByLabel("服装描述", { exact: true })
    .fill("UNSAVED_BUNNY_CLOTHES_WITH_WRIST_BOWS");
  await page
    .getByRole("combobox", { name: "测试人物", exact: true })
    .selectOption("0");
  await page
    .getByRole("button", { name: "预览服装测试请求", exact: true })
    .click();
  await expect(page.locator("#status")).toContainText("尚未提交");
  expect(
    (await page.evaluate(() => window.harness.snapshot())).calls.filter(
      (call) => call.kind === "novelai",
    ),
  ).toHaveLength(0);
  await expect(page.getByLabel("服装描述", { exact: true })).toHaveValue(
    "UNSAVED_BUNNY_CLOTHES_WITH_WRIST_BOWS",
  );
  await page
    .getByRole("button", { name: "生成服装测试图", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "服装测试图 1", exact: true }),
  ).toBeVisible();
  const after = await page.evaluate(() => window.harness.snapshot());
  expect(after.submissions).toBe(0);
  expect(after.attachments).toHaveLength(0);
  expect(after.assets).toBe(0);
  expect(after.files["library-char-A"]).toBe(before.files["library-char-A"]);
  expect(after.files["automatic-config"]).toBe(
    before.files["automatic-config"],
  );
  expect(after.files["automatic-jobs"]).toBe(before.files["automatic-jobs"]);
  expect(after.files["shared-outfits"]).toBeUndefined();
  expect(
    after.calls.filter((call) => ["deepseek", "model"].includes(call.kind)),
  ).toHaveLength(0);
  const requests = after.calls.filter((call) => call.kind === "novelai");
  expect(requests).toHaveLength(1);
  expect(requests[0].payload).toEqual({
    characterId: "char-A",
    prompt: expect.stringMatching(
      /SAVED_APPEARANCE[\s\S]*UNSAVED_BUNNY_CLOTHES_WITH_WRIST_BOWS[\s\S]*45 degrees/,
    ),
    negative: novelAIPreset.negative + " TEST_NEGATIVE",
    parameters: {
      steps: 28,
      sampler: "k_dpmpp_2m_sde",
      scale: 7.5,
      cfg_rescale: 0,
    },
  });
  await page.screenshot({
    path: test.info().outputPath("outfit-test.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "生成服装测试图", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("img", { name: "服装测试图 1", exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.harness.snapshot())).calls.filter(
      (call) => call.kind === "novelai",
    ),
  ).toHaveLength(1);
});

test("测试提交响应丢失时保留原始错误且不自动重复提交", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.mode("uncertain"));
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();

  await page
    .getByRole("button", { name: "生成服装测试图", exact: true })
    .click();
  await expect(page.locator("#status")).toContainText("response lost");
  await expect(
    page.getByRole("button", { name: "生成服装测试图", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "生成服装测试图", exact: true }),
  ).toBeDisabled();
  expect(
    (await page.evaluate(() => window.harness.snapshot())).calls.filter(
      (call) => call.kind === "novelai",
    ),
  ).toHaveLength(1);
  await page.getByText("请求详情与任务记录", { exact: true }).click();
  await page
    .getByRole("button", { name: "清除测试记录（不取消任务）", exact: true })
    .click();

  await expect(
    page.getByRole("button", { name: "生成服装测试图", exact: true }),
  ).toBeEnabled();
});

test("桌面服装编辑与预览并排，人物资料与服装分开显示", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  await expect(page.getByLabel("外观描述", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新增人物专属服装", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "服装管理", exact: true }).click();
  await expect(page.getByLabel("外观描述", { exact: true })).toBeHidden();
  const fields = await page
    .locator(".person-outfits .outfit-fields")
    .boundingBox();
  const preview = await page
    .locator(".person-outfits .outfit-test")
    .boundingBox();
  expect(fields).not.toBeNull();
  expect(preview).not.toBeNull();
  expect(preview!.x).toBeGreaterThan(fields!.x + fields!.width);
  expect(Math.abs(preview!.y - fields!.y)).toBeLessThan(5);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: test.info().outputPath("person-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();
  const editor = await page.locator(".outfit-fields").boundingBox();
  const testPane = await page.locator(".outfit-test").boundingBox();
  expect(testPane!.x).toBeGreaterThan(editor!.x + editor!.width);
  await page.screenshot({
    path: test.info().outputPath("shared-desktop.png"),
    fullPage: true,
  });
});
