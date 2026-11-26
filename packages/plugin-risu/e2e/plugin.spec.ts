import { defaultStyle } from "../src/step2/templates";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { novelAIPreset } from "../src/shared/novelAIPreset";

// prettier-ignore
test.describe.skip("旧单图生成协议", () => {
for (const mode of [
  "person-unknown",
  "person-wrong-id",
  "person-null-id",
  "person-alias",
] as const) {
  test(`人物引用兼容且保持单次模型调用：${mode}`, async ({ page }) => {
    await seed(page, { mode });
    await page.evaluate(() => window.harness.emit());
    await complete(page);
    const saved = await snapshot(page);
    const job = JSON.parse(saved.files["automatic-jobs"])[0];
    expect(
      saved.calls.filter((call) => call.kind === "deepseek"),
    ).toHaveLength(1);
    expect(saved.submissions).toBe(1);
    if (mode === "person-unknown") {
      expect(job.plan.characters[0]).toMatchObject({
        id: null,
        name: "New visitor",
      });
      expect(job.prompt).not.toContain("SAVED_APPEARANCE");
      expect(job.validationWarnings.join("\n")).toContain("缺少固定外观");
    } else {
      expect(job.plan.characters[0].id).toBe("lin");
      expect(job.prompt).toContain("SAVED_APPEARANCE");
      expect(job.validationWarnings.join("\n")).toContain(
        "唯一姓名或别名恢复",
      );
    }
    await page.reload();
    expect(
      (await snapshot(page)).calls.filter((call) => call.kind === "deepseek"),
    ).toHaveLength(1);
  });
}

for (const [mode, expected] of [
  ["outfit-default", "DEFAULT_SAILOR_TOP_NAVY_TIE_WHITE_PLEATED_SKIRT"],
  ["outfit-reference", "ALTERNATE_OUTFIT_ONLY"],
  ["outfit-shared", "SHARED_ROBE_ONLY"],
  ["outfit-custom", "CUSTOM_OUTFIT_ONLY"],
] as const) {
  test(`完整服装注入且不叠加默认衣服：${mode}`, async ({ page }) => {
    await seed(page, { mode });
    await page.evaluate(() => window.harness.emit());
    await complete(page);
    const saved = await snapshot(page);
    const job = JSON.parse(saved.files["automatic-jobs"])[0];
    expect(job.prompt).toContain("Outfit: " + expected);
    if (mode !== "outfit-default")
      expect(job.prompt).not.toContain(
        "DEFAULT_SAILOR_TOP_NAVY_TIE_WHITE_PLEATED_SKIRT",
      );
    const libraries = JSON.parse(
      saved.files["automatic-libraries"] ?? "{}",
    ) as Record<string, { sharedOutfits: { id: string }[] }>;
    expect(
      libraries[job.source.characterId + ":" + job.libraryRevision]
        .sharedOutfits[0].id,
    ).toBe("shared:robe");
    expect(
      saved.calls.filter((call) => call.kind === "deepseek"),
    ).toHaveLength(1);
    if (mode === "outfit-custom") {
      const request = saved.calls.find((call) => call.kind === "deepseek")!
        .payload as { body: { messages: { content: string }[] } };
      expect(request.body.messages[0].content).toContain(
        "no bra 或 no underwear",
      );
      expect(request.body.messages[0].content).toContain(
        "open-cup 或 no cups over the breasts",
      );
      expect(job.plan.characters[0].state).toBe(
        "topless, bare breasts, exposed nipples",
      );
      expect(job.prompt).toContain(
        "Visible state: 示例人物 — topless, bare breasts, exposed nipples",
      );
      expect(job.prompt.indexOf("Visible state:")).toBeLessThan(
        job.prompt.indexOf(defaultStyle),
      );
    }
    expect(saved.submissions).toBe(1);
    await page.reload();
    expect(
      (await snapshot(page)).calls.filter((call) => call.kind === "deepseek"),
    ).toHaveLength(1);
  });
}

test("无效服装引用停止提交，不自动调用模型修正", async ({ page }) => {
  await seed(page, { mode: "outfit-missing" });
  await page.evaluate(() => window.harness.emit());
  await expect
    .poll(
      async () =>
        JSON.parse((await snapshot(page)).files["automatic-jobs"] || "[]")[0]
          ?.state,
    )
    .toBe("error");
  const saved = await snapshot(page);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
  expect(saved.submissions).toBe(0);
});

for (const mode of ["scene-objects-nested", "scene-objects-both"] as const) {
  test(
    "scene 内的 objects 可本地合并，顶层同名优先，不追加模型调用：" + mode,
    async ({ page }) => {
      await seed(page, { mode });
      await page.evaluate(() => window.harness.emit());
      await complete(page);
      const saved = await snapshot(page),
        job = JSON.parse(saved.files["automatic-jobs"])[0];
      expect(
        saved.calls.filter((call) => call.kind === "deepseek"),
      ).toHaveLength(1);
      expect(job.modelCallCount).toBe(1);
      expect(job.plan.objects).toHaveLength(2);
      expect(
        job.plan.objects.find(
          (item: { name: string }) => item.name.toLowerCase() === "lamp",
        ).description,
      ).toBe(mode === "scene-objects-both" ? "ROOT_LAMP" : "NESTED_LAMP");
      expect(job.prompt).toContain("NESTED_LEDGER");
      expect(job.raw).toContain('"scene"');
      expect(JSON.parse(job.raw).scene.objects).toBeTruthy();
      expect(job.validationWarnings).toHaveLength(1);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
      ).toBeVisible();
      expect(
        (await snapshot(page)).calls.filter(
          (call) => call.kind === "deepseek",
        ),
      ).toHaveLength(1);
    },
  );
}
for (const mode of [
  "scene-objects-invalid",
  "scene-description-missing",
] as const) {
  test(
    "scene 真正缺字段或道具格式无效时仍停止且不重试：" + mode,
    async ({ page }) => {
      await seed(page, { mode });
      await page.evaluate(() => window.harness.emit());
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await snapshot(page)).files["automatic-jobs"] || "[]",
            )[0]?.state,
        )
        .toBe("error");
      const saved = await snapshot(page);
      expect(
        saved.calls.filter((call) => call.kind === "deepseek"),
      ).toHaveLength(1);
      expect(saved.submissions).toBe(0);
    },
  );
}
});

async function load(page: Page) {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
}
async function seed(
  page: Page,
  options: {
    mode?: Parameters<Window["harness"]["mode"]>[0];
  } = {},
) {
  await load(page);
  await page.evaluate((options) => {
    window.harness.seedLibrary();
    window.harness.configure({
      enabled: true,
    });
    if (options.mode) window.harness.mode(options.mode);
  }, options);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
}
async function snapshot(page: Page) {
  return page.evaluate(() => window.harness.snapshot());
}
async function history(page: Page) {
  await page.getByRole("button", { name: "图片历史", exact: true }).click();
}
async function complete(page: Page) {
  await history(page);
  await expect(
    page.getByText("图片已显示在对应的助手回复", { exact: true }),
  ).toBeVisible();
}

// prettier-ignore
test.describe.skip("旧单图生成协议", () => {
for (const live of [false, true]) {
  test(`LM Studio 单图写 Tag${live ? "（本机实测）" : ""}`, async ({
    page,
  }) => {
    test.skip(
      live && !process.env.RISU_PLUGIN_LM_STUDIO_LIVE,
      "仅在显式启用时请求本机 LM Studio",
    );
    test.setTimeout(75_000);
    await seed(page, { mode: live ? "lm-studio-live" : "normal" });
    await page.evaluate(() => window.harness.open("automatic"));
    const tagModel = page.getByLabel("写 Tag 模型", { exact: true });
    await expect(tagModel).toHaveValue("deepseek");
    await tagModel.selectOption("lm-studio");
    await expect(page.getByLabel("LM Studio 模型 ID")).toBeVisible();
    await page
      .getByRole("button", { name: "保存自动生图设置到本地", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("自动生图已开启");
    await page.reload();
    await page.evaluate(() => window.harness.open("automatic"));
    await expect(tagModel).toHaveValue("lm-studio");

    await page.evaluate(() =>
      window.harness.emitRaw(
        "我坐在咖啡厅的靠窗座位。阳光照在桌上一把红色的雨伞上，四周空无一人。",
      ),
    );
    await expect
      .poll(
        async () => {
          const snapshot = await page.evaluate(() =>
            window.harness.snapshot(),
          );
          const jobs = JSON.parse(snapshot.files["automatic-jobs"] ?? "[]");
          if (jobs[0]?.state === "error") throw Error(jobs[0].error);
          return jobs[0]?.state;
        },
        { timeout: live ? 60_000 : 10_000 },
      )
      .toBe("complete");

    const saved = await snapshot(page);
    const requests = saved.calls.filter((call) => call.kind === "lm-studio");
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).toMatchObject({
      url: "http://127.0.0.1:1234/v1/chat/completions",
      networkRoute: "local_network",
      headers: { "Content-Type": "application/json" },
      body: {
        model: "huihui-ai/huihui-qwen3.8-27b-abliterated",
        stream: false,
        max_tokens: 8192,
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: "none",
        response_format: { type: "json_schema" },
        messages: [{ role: "system" }, { role: "user" }],
      },
    });
    expect(
      saved.calls.filter((call) => call.kind === "deepseek"),
    ).toHaveLength(0);
    expect(saved.submissions).toBe(1);
    const job = JSON.parse(saved.files["automatic-jobs"])[0];
    expect(job).toMatchObject({
      sourceModelId: "lm-studio",
      modelCallCount: 1,
    });
    if (live) expect(job.usage.reasoningTokens).toBe(0);
  });
}

test("人物简称与括号注释姓名按同一 ID 引用；POV 明确附带资料库引用", async ({
  page,
}) => {
  await seed(page, { mode: "name-short" });
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  const saved = await snapshot(page);
  const calls = saved.calls.filter((call) => call.kind === "deepseek");
  expect(calls).toHaveLength(1);
  const request = calls[0].payload as {
    body: { messages: { content: string }[] };
  };
  expect(request.body.messages[1].content).toContain(
    '"observerName":"示例人物"',
  );
  const job = JSON.parse(saved.files["automatic-jobs"])[0];
  expect(job.modelCallCount).toBe(1);
  expect(job.prompt).toContain(
    "Name: 示例人物\nAppearance: SAVED_APPEARANCE",
  );
  expect(job.plan.characters[0].name).toBe(
    "示例人物（Example Person，用户化身）",
  );
  expect(job.validationWarnings).toHaveLength(1);
});

for (const mode of [
  "background-unknown",
  "background-unknown-nearby",
  "background-empty-library",
  "background-null-exact",
  "background-none-with-id",
] as const) {
  test(
    "背景引用不可用时仍用本轮描述出图，不串用固定背景或追加模型：" + mode,
    async ({ page }) => {
      await seed(page, { mode });
      const libraryBefore = (await snapshot(page)).files["library-char-A"];
      await page.evaluate(() => window.harness.emit());
      await complete(page);
      await expect(page.getByText(/校验警告：/)).toBeVisible();
      const saved = await snapshot(page),
        job = JSON.parse(saved.files["automatic-jobs"])[0];
      expect(
        saved.calls.filter((call) => call.kind === "deepseek"),
      ).toHaveLength(1);
      expect(job.modelCallCount).toBe(1);
      expect(saved.submissions).toBe(1);
      expect(job.plan.scene.backgroundId).toBeNull();
      expect(job.plan.scene.referenceMatch).toBe("none");
      expect(job.prompt).toContain(
        "Environment: Soft daylight falls across the table.",
      );
      expect(job.prompt).not.toContain("Background reference:");
      expect(job.prompt).not.toContain("SAVED_BACKGROUND");
      expect(job.validationWarnings).toHaveLength(1);
      expect(saved.files["library-char-A"]).toBe(libraryBefore);
      const count = saved.submissions;
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
      ).toBeVisible();
      expect((await snapshot(page)).submissions).toBe(count);
    },
  );
}

test("背景 ID 缩写按去掉括注后的名称唯一匹配", async ({ page }) => {
  await seed(page, { mode: "background-abbreviated" });
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  const saved = await snapshot(page),
    job = JSON.parse(saved.files["automatic-jobs"])[0];
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
  expect(job.prompt).toContain("Background reference: SAVED_BACKGROUND");
  expect(job.validationWarnings).toHaveLength(0);
  expect(job.plan.scene.referenceMatch).toBe("exact");
});

for (const mode of ["pov-empty", "pov-interaction", "pov-body"] as const) {
  test(
    "第一人称独立统计画内人物，不注入观察者全身外观：" + mode,
    async ({ page }) => {
      await seed(page, { mode });
      await page.evaluate(() => window.harness.emit());
      await complete(page);
      const saved = await snapshot(page),
        job = JSON.parse(saved.files["automatic-jobs"])[0];
      expect(
        saved.calls.filter((call) => call.kind === "deepseek"),
      ).toHaveLength(1);
      expect(job.plan.view).toMatchObject({
        mode: "first_person",
        observerName: "故事观察者",
      });
      expect(job.prompt).toContain(
        "First-person view through 故事观察者's own eyes",
      );
      expect(job.prompt).toContain(
        (mode === "pov-empty" ? "0" : "1") +
          " listed visible characters; partial framing is allowed",
      );
      expect(job.prompt).not.toContain("complete visible people");
      expect(job.prompt).not.toContain(
        "OBSERVER_APPEARANCE_SHOULD_NOT_RENDER",
      );
      expect(job.prompt).not.toContain("Name: 故事观察者");
      if (mode === "pov-body")
        expect(job.prompt).toContain("right hand resting naturally");
      const request = saved.calls.find((call) => call.kind === "deepseek")!
        .payload as { body: { messages: { content: string }[] } };
      expect(request.body.messages[0].content).toContain(
        '"id":"user","name":"故事观察者"',
      );
      expect(request.body.messages[1].content).toContain(
        '"observerName":"故事观察者"',
      );
      expect(request.body.messages[1].content).not.toContain("observerId");
    },
  );
}

for (const mode of [
  "pov-self",
  "pov-wrong-name",
  "third-no-reason",
  "pov-duplicate",
] as const) {
  test(
    "视角或画内人物协议冲突时停止，不追加模型调用：" + mode,
    async ({ page }) => {
      await seed(page, { mode });
      await page.evaluate(() => window.harness.emit());
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await snapshot(page)).files["automatic-jobs"] || "[]",
            )[0]?.state,
        )
        .toBe("error");
      const saved = await snapshot(page);
      expect(
        saved.calls.filter((call) => call.kind === "deepseek"),
      ).toHaveLength(1);
      expect(saved.submissions).toBe(0);
    },
  );
}

for (const mode of ["identity-switch", "identity-unavailable"] as const) {
  test(
    "POV 身份读取失败或切换聊天时不调用模型：" + mode,
    async ({ page }) => {
      await seed(page, { mode });
      await page.evaluate(() => window.harness.emit());
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await snapshot(page)).files["automatic-jobs"] || "[]",
            )[0]?.state,
        )
        .toBe("error");
      const saved = await snapshot(page);
      expect(
        saved.calls.filter((call) =>
          ["deepseek", "model"].includes(call.kind),
        ),
      ).toHaveLength(0);
      expect(saved.submissions).toBe(0);
      expect(
        JSON.parse(saved.files["automatic-jobs"])[0].userIdentity,
      ).toBeUndefined();
    },
  );
}

test("POV 无 Persona 描述时仍明确传入用户名；预览也使用同一身份来源", async ({
  page,
}) => {
  await seed(page, { mode: "identity-empty-persona" });
  await page.evaluate(() => window.harness.open("automatic"));
  await page
    .getByRole("button", { name: "预览本轮构图 JSON（不生图）", exact: true })
    .click();
  await expect(
    page.getByText(
      "构图 JSON 预览完成，未生图、未改聊天或第一步资料；预览使用已保存的第二步设置",
    ),
  ).toBeVisible();
  const saved = await snapshot(page);
  const calls = saved.calls.filter((call) => call.kind === "deepseek");
  expect(calls).toHaveLength(1);
  const request = calls[0].payload as {
    body: { messages: { content: string }[] };
  };
  expect(request.body.messages[1].content).toContain(
    '"observerName":"故事观察者"',
  );
  expect(request.body.messages[1].content).not.toContain('"persona"');
  expect(saved.submissions).toBe(0);
});

test("旧外观整理和自动修正选项仍存在时也只调用一次", async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.harness.legacyOptions());
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  const saved = await snapshot(page);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
  expect(saved.calls.filter((call) => call.kind === "model")).toHaveLength(0);
  expect(
    JSON.parse(saved.files["automatic-jobs"])[0].appearanceResolution,
  ).toBeUndefined();
});

test("请求已发出但响应未保存时刷新，不自动再调用模型", async ({ page }) => {
  await seed(page, { mode: "model-wait" });
  await page.evaluate(() => window.harness.emit());
  await expect
    .poll(
      async () =>
        (await snapshot(page)).calls.filter(
          (call) => call.kind === "deepseek",
        ).length,
    )
    .toBe(1);
  await page.evaluate(() => window.harness.mode("normal"));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await history(page);
  await expect(page.locator(".preview .danger")).toContainText("未自动重发");
  const saved = await snapshot(page);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
  expect(saved.submissions).toBe(0);
});
});

test("第一步：抽取预览、审阅保存、增量版本和刷新恢复", async ({ page }) => {
  await load(page);
  await page.evaluate(() => window.harness.open("library"));
  await page
    .getByLabel("本次手动抽取的最后一句 prompt")
    .fill("FINAL_MANUAL_REQUEST");
  await page
    .getByRole("button", { name: "手动抽取人物与背景", exact: true })
    .click();
  await expect(page.getByLabel("抽取结果 JSON（可编辑后合并）")).toBeVisible();
  let saved = await snapshot(page);
  expect(saved.files["library-char-A"]).toBeUndefined();
  const request = JSON.stringify(
    saved.calls.filter((call) => call.kind === "model"),
  );
  expect(request).toContain("WORLD_BOOK_SECRET");
  expect(request).toContain("FINAL_MANUAL_REQUEST");
  expect(request).not.toContain("OLDER_USER");
  await page
    .getByRole("button", { name: "保存本次增量更新", exact: true })
    .click();
  await expect(
    page.getByText("已保存 v1 · 已保存", { exact: true }),
  ).toBeVisible();
  saved = await snapshot(page);
  expect(JSON.parse(saved.files["library-char-A"]).revision).toBe(1);
  await page
    .getByRole("button", { name: "手动抽取增量更新", exact: true })
    .click();
  await expect(page.getByLabel("抽取结果 JSON（可编辑后合并）")).toBeVisible();
  await page
    .getByRole("button", { name: "保存本次增量更新", exact: true })
    .click();
  await expect(
    page.getByText("已保存 v2 · 已保存", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.evaluate(() => window.harness.open("library"));
  await expect(
    page.getByText("已保存 v2 · 已保存", { exact: true }),
  ).toBeVisible();
  expect(
    (await snapshot(page)).files["library-char-A-revision-1"],
  ).toBeTruthy();
  await page.screenshot({
    path: test.info().outputPath("step1.png"),
    fullPage: true,
  });
});

// prettier-ignore
test.describe.skip("旧单图生成协议", () => {
test("提示词与画风内置于插件，设置页不暴露且旧配置值不生效", async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => window.harness.seedLibrary());
  await page.evaluate(() =>
    window.harness.configure({
      enabled: true,
      system: "LEGACY_SYSTEM_SHOULD_NOT_APPEAR",
      inputTemplate: "LEGACY_INPUT_SHOULD_NOT_APPEAR",
      style: "LEGACY_STYLE_SHOULD_NOT_APPEAR",
      viewpointGuidance: "LEGACY_VIEWPOINT_SHOULD_NOT_APPEAR",
      promptPrefix: "LEGACY_PREFIX_SHOULD_NOT_APPEAR",
      characterPromptTemplate: "LEGACY_CHARACTER_SHOULD_NOT_APPEAR",
      finalPromptTemplate: "LEGACY_FINAL_SHOULD_NOT_APPEAR",
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "第二步 · 自动生图", exact: true })
    .click();
  for (const label of [
    "自动构图系统提示词",
    "自动构图输入模板",
    "画风",
    "叙事视角偏好（默认用户 POV，多人可调整）",
    "提示词前缀（可留空）",
    "人物引用模板（name、appearanceBlock、action）",
    "最终生图排版模板",
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  const saved = await snapshot(page),
    job = JSON.parse(saved.files["automatic-jobs"])[0],
    request = saved.calls.find((call) => call.kind === "deepseek")!
      .payload as {
      body: { messages: { content: string }[] };
    };
  expect(request.body.messages[0].content).toContain(
    "先根据本轮人物姿势与用户眼睛位置判断可见范围",
  );
  expect(request.body.messages[0].content).not.toContain(
    "LEGACY_SYSTEM_SHOULD_NOT_APPEAR",
  );
  expect(request.body.messages[0].content).not.toContain(
    "LEGACY_VIEWPOINT_SHOULD_NOT_APPEAR",
  );
  expect(request.body.messages[1].content).toContain(
    "请输出描述当前一个瞬间的完整 JSON",
  );
  expect(request.body.messages[1].content).not.toContain(
    "LEGACY_INPUT_SHOULD_NOT_APPEAR",
  );
  expect(job.prompt).toContain(defaultStyle);
  expect(job.prompt).toContain("@painterly cine");
  expect(job.prompt).not.toContain("LEGACY_STYLE_SHOULD_NOT_APPEAR");
  expect(job.prompt).not.toContain("LEGACY_PREFIX_SHOULD_NOT_APPEAR");
  expect(job.prompt).not.toContain("LEGACY_CHARACTER_SHOULD_NOT_APPEAR");
  expect(job.prompt).not.toContain("LEGACY_FINAL_SHOULD_NOT_APPEAR");
});
});

test("两个设置页面独立保存；非法配置显示错误，不覆盖已保存设置", async ({
  page,
}) => {
  await load(page);
  await page.getByRole("button", { name: "抽取设置", exact: true }).click();
  await page.getByLabel("抽取补充要求", { exact: true }).fill("MANUAL_ONLY");
  await page.getByRole("button", { name: "保存抽取设置到本地" }).click();
  await expect(page.getByRole("status")).toContainText("抽取设置已保存");
  await page
    .getByRole("button", { name: "第二步 · 自动生图", exact: true })
    .click();
  await page
    .getByLabel("选景与标签要求", { exact: true })
    .fill("SECOND_STEP_ONLY");
  await page.getByLabel("每楼最多配图张数（1–6）").fill("0");
  await page.getByRole("button", { name: "保存自动生图设置到本地" }).click();
  expect(
    JSON.parse((await snapshot(page)).files["automatic-config"])
      .additionalPrompt,
  ).toBe("EXTRA_REQUIREMENT");
  await page.getByLabel("每楼最多配图张数（1–6）").fill("3");
  await page.getByRole("button", { name: "保存自动生图设置到本地" }).click();
  await expect(page.getByRole("status")).toContainText("自动生图已暂停");
  const saved = await snapshot(page);
  expect(JSON.parse(saved.files["manual-config"]).instructions).toBe(
    "MANUAL_ONLY",
  );
  expect(JSON.parse(saved.files["automatic-config"]).additionalPrompt).toBe(
    "SECOND_STEP_ONLY",
  );
  await page.screenshot({
    path: test.info().outputPath("step2-settings.png"),
    fullPage: true,
  });
});

// prettier-ignore
test.describe.skip("旧单图生成协议", () => {
test("第二步：缺资料时失败，不读世界书、不调用模型或提交 ComfyUI", async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => window.harness.configure({ enabled: true }));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.emit());
  await history(page);
  await expect(
    page
      .locator(".preview .danger")
      .filter({ hasText: "此角色尚未手动抽取并保存人物与背景资料" }),
  ).toBeVisible();
  const saved = await snapshot(page);
  expect(
    saved.calls.filter((call) => ["worldbook", "model"].includes(call.kind)),
  ).toEqual([]);
  expect(saved.submissions).toBe(0);
});

test("第二步：预览不出图，自动队列持久化、只读资料、去重和图片查看", async ({
  page,
}) => {
  await seed(page);
  const before = (await snapshot(page)).files["library-char-A"];
  await page
    .getByRole("button", { name: "第二步 · 自动生图", exact: true })
    .click();
  await page
    .getByRole("button", { name: "预览本轮构图 JSON（不生图）" })
    .click();
  await expect(
    page.getByRole("heading", { name: "构图 JSON 预览", exact: true }),
  ).toBeVisible();
  expect((await snapshot(page)).submissions).toBe(0);
  await page.evaluate(() => {
    window.harness.emit();
    window.harness.emit();
  });
  await complete(page);
  const saved = await snapshot(page);
  expect(saved.submissions).toBe(1);
  expect(saved.attachments).toHaveLength(1);
  expect(saved.files["library-char-A"]).toBe(before);
  expect(saved.calls.filter((call) => call.kind === "worldbook")).toEqual([]);
  const models = saved.calls.filter((call) => call.kind === "deepseek");
  const prompt = JSON.stringify(models.at(-1));
  expect(prompt).toContain("LATEST_USER_1");
  expect(prompt).toContain("LATEST_ASSISTANT_1");
  expect(prompt).not.toMatch(
    /SAVED_APPEARANCE|SAVED_BACKGROUND|OLDER_USER|WORLD_BOOK_SECRET/,
  );
  await expect(page.getByRole("img")).toBeVisible();
  await page.getByRole("img").click();
  await expect(page.getByRole("img")).toHaveClass("large");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("img")).not.toHaveClass("large");
  await page.screenshot({
    path: test.info().outputPath("history.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  expect((await snapshot(page)).submissions).toBe(1);
});

test("自动生图通过 RisuAI 调用 NovelAI 并挂载到原回复", async ({ page }) => {
  await seed(page);
  await page.evaluate(() =>
    window.harness.configure({ useNovelAI: true, url: "", workflow: "" }),
  );
  await page.reload();
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  const saved = await snapshot(page);
  const requests = saved.calls.filter((call) => call.kind === "novelai");
  expect(requests).toHaveLength(1);
  expect(requests[0].payload).toMatchObject({
    characterId: "char-A",
    prompt: expect.stringMatching(
      /^1\.35::very aesthetic,[\s\S]*SAVED_APPEARANCE/,
    ),
    negative: novelAIPreset.negative,
    parameters: {
      steps: 28,
      sampler: "k_dpmpp_2m_sde",
      scale: 7.5,
      cfg_rescale: 0,
    },
  });
  expect(saved.submissions).toBe(0);
  expect(saved.attachments).toHaveLength(1);
  await expect(page.getByRole("img")).toBeVisible();
});

test("提交响应丢失后保持待确认，刷新和重复事件不会重复出图", async ({
  page,
}) => {
  await seed(page, { mode: "uncertain" });
  await page.evaluate(() => window.harness.emit());
  await history(page);
  await expect(
    page.getByText("提交结果待确认", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.emit());
  await history(page);
  await expect(
    page.getByText("提交结果待确认", { exact: true }),
  ).toBeVisible();
  expect((await snapshot(page)).submissions).toBe(1);
});

for (const mode of [
  "repair",
  "appearance-output",
  "blank",
  "truncated",
  "http-error",
  "model-network",
  "mismatch",
] as const) {
  test(
    "单次 DeepSeek 失败不追加调用，刷新不重发：" + mode,
    async ({ page }) => {
      await seed(page, { mode });
      await page.evaluate(() => window.harness.emit());
      await history(page);
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await snapshot(page)).files["automatic-jobs"] || "[]",
            )[0]?.state,
        )
        .toBe("error");
      let saved = await snapshot(page);
      expect(
        saved.calls.filter((call) => call.kind === "deepseek"),
      ).toHaveLength(1);
      expect(
        saved.calls.filter((call) => call.kind === "model"),
      ).toHaveLength(0);
      expect(saved.submissions).toBe(0);
      const job = JSON.parse(saved.files["automatic-jobs"])[0];
      expect(job.modelCallCount).toBe(1);
      if (
        [
          "repair",
          "appearance-output",
          "blank",
          "truncated",
          "mismatch",
        ].includes(mode)
      )
        expect(typeof job.raw).toBe("string");
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
      ).toBeVisible();
      await page.evaluate(() => window.harness.emit());
      await history(page);
      saved = await snapshot(page);
      expect(
        saved.calls.filter((call) => call.kind === "deepseek"),
      ).toHaveLength(1);
      expect(saved.submissions).toBe(0);
    },
  );
}

test("DeepSeek JSON 请求仅一次；姓名、原 appearance 与动作按 ID 一一对应，密钥不进入任务", async ({
  page,
}) => {
  await seed(page, { mode: "multi" });
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  const saved = await snapshot(page),
    calls = saved.calls.filter((call) => call.kind === "deepseek");
  expect(calls).toHaveLength(1);
  expect(saved.calls.filter((call) => call.kind === "model")).toHaveLength(0);
  const request = calls[0].payload as {
    body: {
      response_format: { type: string };
      stream: boolean;
      messages: { content: string }[];
    };
  };
  expect(request.body.response_format).toEqual({ type: "json_object" });
  expect(request.body.stream).toBe(false);
  expect(request.body.messages[0].content).toContain("用户 POV");
  expect(request.body.messages[0].content).toContain("不受人数限制");
  expect(request.body.messages[0].content).toContain("不要鱼眼");
  expect(request.body.messages[1].content).toContain(
    '"observerName":"故事观察者"',
  );
  expect(request.body.messages[1].content).toContain(
    '"observerName":"故事观察者"',
  );
  expect(request.body.messages[1].content).toContain(
    "它不是对话助手或其他人物",
  );
  expect(JSON.stringify(request.body.messages)).not.toMatch(
    /SAVED_APPEARANCE|SECOND_APPEARANCE|ABSENT_APPEARANCE|SAVED_BACKGROUND/,
  );
  const job = JSON.parse(saved.files["automatic-jobs"])[0];
  expect(job.modelCallCount).toBe(1);
  expect(job.userIdentity).toEqual({
    name: "故事观察者",
    persona: "SYNTHETIC_CURRENT_CHAT_PERSONA",
  });
  expect(job.prompt).toContain(
    "Name: 示例人物\nAppearance: SAVED_APPEARANCE\nAction: She holds a cup.",
  );
  expect(job.prompt).toContain(
    "Name: 第二人物\nAppearance: SECOND_APPEARANCE\nAction: He sets a book down.",
  );
  expect(job.prompt).toContain("Background reference: SAVED_BACKGROUND");
  expect(job.prompt).not.toContain("ABSENT_APPEARANCE");
  expect(job.raw).not.toContain("appearance");
  expect(JSON.stringify(job)).not.toContain("SYNTHETIC_TEST_CREDENTIAL");
  expect(saved.files["library-char-A"]).toContain("SECOND_APPEARANCE");
});

test("图片附件失败后可重试挂载；重新生成只替换原回复图片且保留旧图直到成功", async ({
  page,
}) => {
  await seed(page, { mode: "attachment-failure" });
  await page.evaluate(() => window.harness.emit());
  await history(page);
  await expect(
    page.getByText("原回复已修改或删除", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.mode("normal"));
  await page
    .getByRole("button", { name: "显示到对应回复下方（不重新生图）" })
    .click();
  await expect(
    page.getByText("图片已显示在对应的助手回复下方"),
  ).toBeVisible();
  expect((await snapshot(page)).submissions).toBe(1);
  await page.evaluate(() =>
    window.harness.request("regenerate", false, "orphan-attachment:0"),
  );
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const saved = await snapshot(page),
    jobs = JSON.parse(saved.files["automatic-jobs"]);
  expect(saved.submissions).toBe(2);
  expect(jobs[0].supersededBy).toBe(jobs[1].id);
  expect(
    (saved.attachments[1] as { replaceImageIds: string[] }).replaceImageIds,
  ).toEqual(
    expect.arrayContaining([jobs[0].id + ":0", "orphan-attachment:0"]),
  );
});

test("复制的旧回复重绘时复用原图构图，并按实际图片 ID 替换", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => window.harness.emitRaw("LATEST_ASSISTANT"));
  await complete(page);
  const original = JSON.parse(
    (await snapshot(page)).files["automatic-jobs"],
  )[0];
  await page.evaluate((jobId) => {
    window.harness.moveJobToOriginalChat(jobId);
    window.harness.configure({ mainModelPrompt: true, useNovelAI: true });
  }, original.id as string);
  await page.reload();
  await page.evaluate(
    (imageId) => window.harness.request("regenerate", true, imageId),
    original.id + ":0",
  );
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const saved = await snapshot(page);
  const latest = JSON.parse(saved.files["automatic-jobs"]).at(-1);
  expect(latest.raw).toBe(original.raw);
  expect(latest.modelCallCount).toBe(0);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
  expect(saved.calls.filter((call) => call.kind === "novelai")).toHaveLength(
    1,
  );
  expect(saved.attachments.at(-1)).toMatchObject({
    chatId: "chat-A",
    replaceImageIds: expect.arrayContaining([original.id + ":0"]),
  });
});

test("手动给没有绘图块和旧记录的回复补图时只构图一次", async ({ page }) => {
  await seed(page);
  await page.evaluate(() =>
    window.harness.configure({ mainModelPrompt: true, useNovelAI: true }),
  );
  await page.reload();
  await page.evaluate(() => window.harness.request("fill", true));
  await complete(page);
  const saved = await snapshot(page);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
  expect(saved.calls.filter((call) => call.kind === "novelai")).toHaveLength(
    1,
  );
});

test("模型拒绝不进入修正或提交；卸载后不再接收助手事件", async ({ page }) => {
  await seed(page, { mode: "refusal" });
  await page.evaluate(() => window.harness.emit());
  await history(page);
  await expect(
    page
      .locator(".preview .danger")
      .filter({ hasText: "模型未返回完整 JSON" }),
  ).toBeVisible();
  let saved = await snapshot(page);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
  expect(saved.submissions).toBe(0);
  await page.evaluate(() => window.harness.unload());
  await page.evaluate(() => window.harness.emit(2));
  saved = await snapshot(page);
  expect(JSON.parse(saved.files["automatic-jobs"])).toHaveLength(1);
});

test("连续助手回复按顺序入队；ComfyUI 请求使用本地代理，队列不串用消息", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => {
    window.harness.emit(1);
    window.harness.emit(2);
    window.harness.emit(2);
    window.harness.emit(3);
  });
  await history(page);
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await snapshot(page)).files["automatic-jobs"] || "[]",
        ).filter(
          (job: { attachmentState: string }) =>
            job.attachmentState === "attached",
        ).length,
    )
    .toBe(3);
  const saved = await snapshot(page),
    jobs = JSON.parse(saved.files["automatic-jobs"]);
  expect(
    jobs.map(
      (job: { pair: { userMessage: string } }) => job.pair.userMessage,
    ),
  ).toEqual(["LATEST_USER_1", "LATEST_USER_2", "LATEST_USER_3"]);
  expect(saved.submissions).toBe(3);
  const requests = saved.calls
    .filter((call) => call.kind === "fetch")
    .map((call) => call.payload as { options: { networkRoute: string } });
  expect(
    requests.every((call) => call.options.networkRoute === "local_network"),
  ).toBe(true);
});

test("构图与出图两阶段流水线：上一张未返回时已整理下一条", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => {
    window.harness.configure({ useNovelAI: true });
    window.harness.mode("novelai-slow");
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.harness.emit(1);
    window.harness.emit(2);
  });
  await expect
    .poll(
      async () => {
        const saved = await snapshot(page);
        return {
          deepseek: saved.calls.filter((call) => call.kind === "deepseek")
            .length,
          novelai: saved.calls.filter((call) => call.kind === "novelai")
            .length,
        };
      },
      { timeout: 10_000 },
    )
    .toEqual({ deepseek: 2, novelai: 1 });
  await page.evaluate(() => window.harness.releaseNovelAI());
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await snapshot(page)).files["automatic-jobs"] || "[]",
        ).filter(
          (job: { attachmentState: string }) =>
            job.attachmentState === "attached",
        ).length,
    )
    .toBe(2);
  const saved = await snapshot(page);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    2,
  );
  expect(saved.calls.filter((call) => call.kind === "novelai")).toHaveLength(
    2,
  );
});

test("非安全上下文（远程 HTTP）仍可入队生图并使用 uuid 降级", async ({
  page,
}) => {
  // Browsers only expose crypto.subtle / randomUUID on HTTPS or localhost.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "subtle", {
      configurable: true,
      get: () => undefined,
    });
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      configurable: true,
      get: () => undefined,
    });
  });
  await seed(page);
  expect(await page.evaluate(() => typeof crypto.subtle)).toBe("undefined");
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();
  await page.getByRole("button", { name: "新增服装", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "未命名服装", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.harness.emit());
  await complete(page);
  const saved = await snapshot(page);
  const job = JSON.parse(saved.files["automatic-jobs"])[0];
  expect(job.state).toBe("complete");
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
});

test("已提交任务在刷新后继续查询，不重复调用模型或提交工作流", async ({
  page,
}) => {
  await seed(page, { mode: "polling" });
  await page.evaluate(() => window.harness.emit());
  await expect
    .poll(
      async () =>
        JSON.parse((await snapshot(page)).files["automatic-jobs"] || "[]")[0]
          ?.promptId,
    )
    .toBe("prompt-1");
  await page.evaluate(() => window.harness.mode("normal"));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await complete(page);
  const saved = await snapshot(page);
  expect(saved.submissions).toBe(1);
  expect(saved.calls.filter((call) => call.kind === "deepseek")).toHaveLength(
    1,
  );
});

test("导入旧 ComfyUI 历史并下载原图，不重新生成", async ({ page }) => {
  await load(page);
  await history(page);
  await page
    .getByRole("button", { name: "导入 ComfyUI 最近历史（不生图）" })
    .click();
  await expect(
    page.getByRole("heading", { name: "ComfyUI 历史 · 导入任务" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续查询（不重新生图）" }).click();
  await expect(page.getByRole("link", { name: "下载原图" })).toBeVisible();
  expect((await snapshot(page)).submissions).toBe(0);
});
});

test("移动端可切换两个步骤和设置页，没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page);
  await page.evaluate(() => window.harness.open("library"));
  for (const title of [
    "抽取设置",
    "公用服装库",
    "第二步 · 自动生图",
    "第一步 · 人物与背景资料",
  ]) {
    await page.getByRole("button", { name: title, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: test.info().outputPath("mobile.png"),
    fullPage: true,
  });
});

test("资料表单保留跨页面草稿、扩展字段，校验失败不覆盖资料", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => window.harness.open("library"));
  await page.getByLabel("外观描述", { exact: true }).fill("EDITED_APPEARANCE");
  await page.getByRole("button", { name: "抽取设置", exact: true }).click();
  await page
    .getByRole("button", { name: "第一步 · 人物与背景资料", exact: true })
    .click();
  await expect(page.getByLabel("外观描述", { exact: true })).toHaveValue(
    "EDITED_APPEARANCE",
  );
  await page.getByLabel("名称", { exact: true }).fill("");
  await page.getByRole("button", { name: "保存资料修改", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("每条资料需要");
  expect(
    JSON.parse((await snapshot(page)).files["library-char-A"]).revision,
  ).toBe(1);
  await page.getByLabel("名称", { exact: true }).fill("编辑人物");
  await page.getByRole("button", { name: "保存资料修改", exact: true }).click();
  await expect(
    page.getByText("已保存 v2 · 已保存", { exact: true }),
  ).toBeVisible();
  const library = JSON.parse((await snapshot(page)).files["library-char-A"]);
  expect(library.people[0]).toMatchObject({
    id: "lin",
    name: "编辑人物",
    appearance: "EDITED_APPEARANCE",
    notes: "SAVED_NOTES",
  });
  expect(library.backgrounds[0].description).toBe("SAVED_BACKGROUND");
  await page.reload();
  await page.evaluate(() => window.harness.open("library"));
  await expect(page.getByLabel("外观描述", { exact: true })).toHaveValue(
    "EDITED_APPEARANCE",
  );
});

test("输入预览和离线校验不调用模型、不写资料，调试记录可导出", async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => window.harness.open("library"));
  const before = (await snapshot(page)).files;
  await page
    .getByRole("button", { name: "仅预览抽取输入", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("输入预览完成");
  await page.getByText("实际请求消息", { exact: true }).click();
  await expect(page.getByText(/WORLD_BOOK_SECRET/)).toBeVisible();
  await page.getByLabel("粘贴模型响应（仅离线校验）").fill("broken");
  await page.getByRole("button", { name: "离线校验响应", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("不是完整 JSON");
  await page
    .getByLabel("粘贴模型响应（仅离线校验）")
    .fill('{"people":[],"backgrounds":[]}');
  await page.getByRole("button", { name: "离线校验响应", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("离线校验通过");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出调试记录", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(
    "risu-extraction-debug.json",
  );
  const saved = await snapshot(page);
  expect(saved.files).toEqual(before);
  expect(saved.calls.filter((call) => call.kind === "model")).toHaveLength(0);
  expect(saved.submissions).toBe(0);
});

test("抽取解析失败仍保留原始响应和实际请求", async ({ page }) => {
  await load(page);
  await page.evaluate(() => window.harness.mode("extraction-invalid"));
  await page.evaluate(() => window.harness.open("library"));
  await page
    .getByRole("button", { name: "手动抽取人物与背景", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("不是完整 JSON");
  await page.getByText("模型原始响应", { exact: true }).click();
  await expect(
    page.getByText("RAW_BROKEN_RESPONSE {", { exact: true }),
  ).toBeVisible();
  const saved = await snapshot(page);
  expect(saved.files["library-char-A"]).toBeUndefined();
  expect(saved.calls.filter((call) => call.kind === "model")).toHaveLength(1);
});

test("公用服装保存恢复、复制到人物草稿，保持资料读取协议", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();
  await expect(page.getByLabel("服装描述", { exact: true })).toHaveValue(
    /black bow tie/,
  );
  await expect(page.getByLabel("服装描述", { exact: true })).toHaveValue(
    /both wrists/,
  );
  await expect(page.getByLabel("服装描述", { exact: true })).toHaveValue(
    /black wrist bow/,
  );
  await expect(page.getByLabel("服装描述", { exact: true })).toHaveValue(
    /black full-length pantyhose/,
  );
  await page.screenshot({
    path: test.info().outputPath("outfits.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "新增服装", exact: true }).click();
  await page.getByLabel("服装名称", { exact: true }).fill("礼服");
  await page.getByLabel("服装描述", { exact: true }).fill("OUTFIT_DESCRIPTION");
  await page
    .getByRole("button", { name: "保存公用服装库", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("公用服装库已保存");
  await page.reload();
  await page.getByRole("button", { name: "公用服装库", exact: true }).click();
  await page.getByRole("button", { name: "礼服", exact: false }).click();
  await expect(page.getByLabel("服装描述", { exact: true })).toHaveValue(
    "OUTFIT_DESCRIPTION",
  );
  await page
    .getByRole("button", { name: "第一步 · 人物与背景资料", exact: true })
    .click();
  await page.getByText("从公用服装库复制描述", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "选择已保存服装" })
    .selectOption({ label: "礼服" });
  await expect(
    page.getByRole("combobox", { name: "选择已保存服装" }),
  ).toHaveValue(/.+/);
  await page
    .getByRole("button", { name: "追加服装描述到外观草稿", exact: true })
    .click();
  await expect(page.getByLabel("外观描述", { exact: true })).toHaveValue(
    "SAVED_APPEARANCE\n\nOUTFIT_DESCRIPTION",
  );
  expect(
    JSON.parse((await snapshot(page)).files["library-char-A"]).revision,
  ).toBe(1);
  await page.getByRole("button", { name: "保存资料修改", exact: true }).click();
  await expect(
    page.getByText("已保存 v2 · 已保存", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.harness.illustrationResponse(
      JSON.stringify([
        {
          at: "P001",
          summary: "人物穿搭",
          prompt: "1girl, garden | girl, @lin",
        },
      ]),
    );
    window.harness.emit();
  });
  await complete(page);
  const saved = await snapshot(page);
  expect(
    JSON.parse(saved.files["automatic-jobs"])[0].illustration.characters[0]
      .positive,
  ).toContain("OUTFIT_DESCRIPTION");
  expect(saved.calls.filter((call) => call.kind === "model")).toHaveLength(1);
  await page.screenshot({
    path: test.info().outputPath("workspace.png"),
    fullPage: true,
  });
});
