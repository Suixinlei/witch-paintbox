import { expect, test, type Page } from "@playwright/test";
import type { GenerationJob } from "../src/domain/types";

const first = "Lin pours tea beside the window.";
const second = "Later Lin watches lanterns on the bridge.";
const reply = `${first}\n\n<think>\nHIDDEN\n</think>\n\n${second}\n<statusData>\nc|equipment:DO_NOT_USE\n</statusData>`;
const illustrations = [
  {
    at: "P002",
    summary: "桥上看灯",
    size: "1344x768",
    prompt: "1girl, bridge, lanterns | girl, @lin, green coat",
  },
  {
    at: "P001",
    summary: "窗边倒茶",
    size: "832x1216",
    prompt:
      "1girl, tea room, 1.2::warm, soft light:: | girl, @lin, white blouse ~ glasses",
  },
];

async function setup(page: Page) {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate((plan) => {
    window.harness.seedLibrary();
    window.harness.configure({ enabled: true, artistPrompt: "watercolor" });
    window.harness.illustrationResponse(JSON.stringify(plan));
  }, illustrations);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
}

const snapshot = (page: Page) => page.evaluate(() => window.harness.snapshot());
async function jobs(page: Page): Promise<GenerationJob[]> {
  return JSON.parse((await snapshot(page)).files["automatic-jobs"] ?? "[]");
}

test("一次配图请求生成两幅原位插图，重画只替换选中的图", async ({ page }) => {
  await setup(page);
  await page.evaluate((text) => {
    window.harness.emitRaw(text);
    window.harness.emitRaw(text);
  }, reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const original = await snapshot(page);
  const model = original.calls.filter(({ kind }) => kind === "model");
  expect(model).toHaveLength(1);
  const messages = JSON.stringify(model[0].payload);
  expect(messages).toContain("P001");
  expect(messages).toContain("P002");
  expect(messages).not.toContain("HIDDEN");
  expect(messages).not.toContain("DO_NOT_USE");
  expect(messages).not.toContain("SAVED_APPEARANCE");
  expect(
    original.calls
      .filter(({ kind }) => kind === "novelai")
      .map(({ payload }) => payload),
  ).toEqual([
    expect.objectContaining({
      size: "832x1216",
      prompt: "1girl, tea room, 1.2::warm, soft light::, watercolor",
      characters: [
        {
          positive: "girl, SAVED_APPEARANCE, white blouse",
          negative: "glasses",
        },
      ],
    }),
    expect.objectContaining({
      size: "1344x768",
      prompt: "1girl, bridge, lanterns, watercolor",
      characters: [
        { positive: "girl, SAVED_APPEARANCE, green coat", negative: "" },
      ],
    }),
  ]);
  const [tea, bridge] = await jobs(page);
  expect(original.attachments).toEqual([
    expect.objectContaining({
      expectedRawMessageText: reply,
      images: [
        expect.objectContaining({ offset: first.length, alt: "窗边倒茶" }),
      ],
    }),
    expect.objectContaining({
      images: [
        expect.objectContaining({
          offset: reply.indexOf(second) + second.length,
          alt: "桥上看灯",
        }),
      ],
    }),
  ]);

  expect(
    await page.evaluate(
      (id) => window.harness.request("regenerate", true, id),
      tea.id + ":0",
    ),
  ).toMatchObject({ accepted: true });
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(3);
  const repainted = await snapshot(page);
  expect(repainted.calls.filter(({ kind }) => kind === "model")).toHaveLength(
    1,
  );
  expect(repainted.calls.filter(({ kind }) => kind === "novelai")).toHaveLength(
    3,
  );
  expect(
    repainted.calls.filter(({ kind }) => kind === "novelai").at(-1)?.payload,
  ).toMatchObject({ size: "832x1216" });
  expect(repainted.attachments[2]).toMatchObject({
    images: [expect.objectContaining({ offset: first.length, order: 0 })],
    replaceImageIds: expect.arrayContaining([tea.id + ":0"]),
  });
  expect(
    (await jobs(page)).find(({ id }) => id === bridge.id)?.supersededBy,
  ).toBeUndefined();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect.poll(async () => (await jobs(page)).length).toBe(3);
  expect(
    (await snapshot(page)).calls.filter(({ kind }) => kind === "novelai"),
  ).toHaveLength(3);
});

test("非法插入点拒绝整楼计划，空数组成功跳过", async ({ page }) => {
  await setup(page);
  await page.evaluate((text) => {
    window.harness.illustrationResponse(
      JSON.stringify([{ at: "P009", summary: "未知", prompt: "garden" }]),
    );
    window.harness.emitRaw(text);
  }, reply);
  await expect
    .poll(async () => (await jobs(page))[0]?.error)
    .toContain("无效的配图位置");
  await page.evaluate((text) => {
    window.harness.illustrationResponse("[]");
    window.harness.emitRaw(text, "reply-2");
  }, reply);
  await expect
    .poll(async () => (await jobs(page)).at(-1)?.noIllustrations)
    .toBe(true);
  const saved = await snapshot(page);
  expect(saved.calls.filter(({ kind }) => kind === "model")).toHaveLength(2);
  expect(saved.calls.filter(({ kind }) => kind === "novelai")).toHaveLength(0);
  expect(saved.attachments).toHaveLength(0);
});

test("整楼生图重新规划，仅在整批成功后一次替换旧图", async ({ page }) => {
  await setup(page);
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);

  await page.evaluate(() => window.harness.mode("attachment-failure"));
  expect(
    await page.evaluate(() => window.harness.request("replace", true)),
  ).toMatchObject({ accepted: true });
  await expect
    .poll(async () => (await jobs(page)).at(-1)?.attachmentState)
    .toBe("error");
  expect((await snapshot(page)).attachments).toHaveLength(2);

  await page.evaluate(() => window.harness.mode("normal"));
  expect(
    await page.evaluate(() => window.harness.request("replace", true)),
  ).toMatchObject({ accepted: true });
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(3);
  const saved = await snapshot(page);
  expect(saved.calls.filter(({ kind }) => kind === "model")).toHaveLength(3);
  expect(saved.attachments[2]).toMatchObject({
    replaceAll: true,
    expectedRawMessageText: reply,
    images: [
      expect.objectContaining({ offset: first.length }),
      expect.objectContaining({
        offset: reply.indexOf(second) + second.length,
      }),
    ],
  });
});

test("单张失败后补图复用已保存标签，保留同楼成功图", async ({ page }) => {
  await setup(page);
  await page.evaluate((text) => {
    window.harness.mode("novelai-fail-second");
    window.harness.emitRaw(text);
  }, reply);
  await expect
    .poll(async () => (await jobs(page))[1]?.error)
    .toContain("second image failed");
  expect((await snapshot(page)).attachments).toHaveLength(1);
  expect(
    await page.evaluate(() => window.harness.request("fill", true)),
  ).toMatchObject({ accepted: true });
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const saved = await snapshot(page);
  expect(saved.calls.filter(({ kind }) => kind === "model")).toHaveLength(1);
  expect(saved.calls.filter(({ kind }) => kind === "novelai")).toHaveLength(3);
  const [tea] = await jobs(page);
  expect(saved.attachments[1]).toMatchObject({
    replaceImageIds: [expect.not.stringMatching(tea.id)],
  });
});

test("无效画幅回退，固定画幅忽略模型尺寸", async ({ page }) => {
  await setup(page);
  await page.evaluate((text) => {
    window.harness.illustrationResponse(
      JSON.stringify([
        {
          at: "P001",
          summary: "窗边倒茶",
          prompt: "tea room",
          size: "999x888",
        },
      ]),
    );
    window.harness.emitRaw(text);
  }, reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(1);
  expect((await jobs(page))[0].illustration?.size).toBeUndefined();

  await page.evaluate(() => {
    window.harness.illustrationResponse(
      JSON.stringify([
        {
          at: "P002",
          summary: "桥上看灯",
          prompt: "bridge, lanterns",
          size: "1216x832",
        },
      ]),
    );
  });
  await page
    .getByRole("button", { name: "第二步 · 自动生图", exact: true })
    .click();
  await page.getByLabel("AI 动态画幅").uncheck();
  await page.getByRole("button", { name: "保存自动生图设置到本地" }).click();
  await expect
    .poll(
      async () =>
        JSON.parse((await snapshot(page)).files["automatic-config"])
          .dynamicImageSize,
    )
    .toBe(false);
  await expect(page.getByLabel("AI 动态画幅")).not.toBeChecked();
  await page.evaluate((text) => window.harness.emitRaw(text, "reply-2"), reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const saved = await snapshot(page);
  expect((await jobs(page)).at(-1)?.illustration?.size).toBeUndefined();
  expect(
    saved.calls.filter(({ kind }) => kind === "novelai").at(-1)?.payload,
  ).not.toHaveProperty("size");
});

test("跳过模型思考块，并复用之前落盘的配图结果", async ({ page }) => {
  await setup(page);
  const combined = illustrations.map((item) => ({
    ...item,
    prompt:
      item.prompt.replace(
        "@lin",
        item.at === "P001" ? "@lin, @lin:lin:alternate" : "@lin:unregistered",
      ) + " |",
  }));
  const raw =
    "<Thoughts>考虑两个镜头。</Thoughts>\n" + JSON.stringify(combined);
  await page.evaluate((raw) => {
    window.harness.mode("outfit-reference");
    window.harness.illustrationResponse(raw);
  }, raw);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const saved = await jobs(page);
  expect(saved[0].illustration?.characters[0].positive).toContain(
    "ALTERNATE_OUTFIT_ONLY",
  );
  expect(
    saved[0].illustration?.characters[0].positive.match(/SAVED_APPEARANCE/g),
  ).toHaveLength(1);
  expect(saved[1].illustration?.characters[0].positive).toContain(
    "SAVED_APPEARANCE",
  );
  expect(saved[1].illustration?.warnings?.[0]).toContain("服装引用未匹配");
  const legacyRecord = JSON.stringify([
    {
      ...saved[0],
      illustration: undefined,
      illustrationBatch: undefined,
      illustrationOrder: undefined,
      state: "error",
      prompt: undefined,
      files: [],
      imageAssets: undefined,
      attachmentState: undefined,
      error: "JSON Parse error: Unrecognized token '<'",
    },
  ]);
  await page.evaluate(
    (record) => window.risuai.writeServerFile("automatic-jobs", record),
    legacyRecord,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  expect(
    await page.evaluate(() => window.harness.request("fill", true)),
  ).toMatchObject({ accepted: true, jobId: saved[0].id });
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(4);
  expect(
    (await snapshot(page)).calls.filter(({ kind }) => kind === "model"),
  ).toHaveLength(1);
});

test("观察者占位符保留可见背影并省略离镜观察者", async ({ page }) => {
  await setup(page);
  await page.evaluate((text) => {
    window.harness.illustrationResponse(
      JSON.stringify([
        {
          at: "P001",
          summary: "背影视角",
          prompt:
            "garden, over the shoulder | boy, @observer is not drawn unless visible; seen from behind, seated | girl, @lin",
        },
        {
          at: "P002",
          summary: "第一人称",
          prompt: "bridge, pov | @$observer is offscreen | girl, @lin, waving",
        },
      ]),
    );
    window.harness.emitRaw(text);
  }, reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const [rear, pov] = await jobs(page);
  expect(rear.illustration?.characters).toEqual([
    { positive: "boy, seen from behind, seated", negative: "" },
    { positive: "girl, SAVED_APPEARANCE", negative: "" },
  ]);
  expect(pov.illustration?.characters).toEqual([
    { positive: "girl, SAVED_APPEARANCE, waving", negative: "" },
  ]);
});

test("配图模型收到本楼命中的世界书，NovelAI 只收到成图标签", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate((text) => {
    window.harness.illustrationLore([
      { comment: "常驻", alwaysActive: true, content: "WORLDBOOK_ALWAYS" },
      {
        comment: "桥上的服装",
        key: "bridge",
        secondkey: "/lanterns/i",
        selective: true,
        content: "WORLDBOOK_MATCHED",
      },
      {
        key: "tea",
        secondkey: "snow",
        selective: true,
        content: "WORLDBOOK_SECONDARY_MISSING",
      },
      { key: "HIDDEN", content: "WORLDBOOK_HIDDEN" },
      { key: "LATEST_USER_1", content: "WORLDBOOK_ONLY_IN_USER_TURN" },
      { key: "P001", content: "WORLDBOOK_ONLY_IN_NUMBER" },
      { alwaysActive: true, disabled: true, content: "WORLDBOOK_DISABLED" },
    ]);
    window.harness.emitRaw(text);
  }, reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const saved = await snapshot(page);
  const requests = saved.calls.filter(({ kind }) => kind === "model");
  expect(requests).toHaveLength(1);
  expect(requests[0].payload).toMatchObject({
    messages: [
      expect.objectContaining({ role: "system" }),
      {
        role: "system",
        content:
          "本轮世界书资料\n常驻\nWORLDBOOK_ALWAYS\n\n桥上的服装\nWORLDBOOK_MATCHED",
      },
      expect.objectContaining({ role: "user" }),
    ],
  });
  expect(
    JSON.stringify(saved.calls.filter(({ kind }) => kind === "novelai")),
  ).not.toContain("WORLDBOOK_");
  expect((await jobs(page))[0].worldbook?.map(({ title }) => title)).toEqual([
    "常驻",
    "桥上的服装",
  ]);
});

test("本机 LM Studio 单独写标签，优先保留命中世界书并为输出留空间", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.harness.configure({ planningModel: "lm-studio" });
    window.harness.illustrationResponse(
      JSON.stringify([
        {
          at: "P001",
          summary: "已登记人物",
          prompt: "garden | girl, @lin, singing",
        },
        {
          at: "P002",
          summary: "未登记人物",
          prompt: "bridge | boy, @unregistered, blue jacket",
        },
      ]),
    );
    window.harness.illustrationLore([
      {
        comment: "超长常驻",
        alwaysActive: true,
        content: "LONG_LORE " + "山".repeat(40000),
      },
      { comment: "本段服装", key: "bridge", content: "KEEP_BRIDGE_OUTFIT" },
    ]);
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const saved = await snapshot(page);
  expect(saved.calls.filter(({ kind }) => kind === "model")).toHaveLength(0);
  const requests = saved.calls.filter(({ kind }) => kind === "lm-studio");
  expect(requests).toHaveLength(1);
  expect(requests[0].payload).toMatchObject({
    url: "http://127.0.0.1:1234/v1/chat/completions",
    networkRoute: "local_network",
    body: {
      max_tokens: 4096,
      response_format: { json_schema: { schema: { type: "array" } } },
    },
  });
  expect(JSON.stringify(requests[0].payload)).toContain("KEEP_BRIDGE_OUTFIT");
  expect(JSON.stringify(requests[0].payload)).not.toContain("LONG_LORE");
  expect((await jobs(page))[1].illustration?.characters[0].positive).toBe(
    "boy, blue jacket",
  );
  expect((await jobs(page))[1].illustration?.warnings?.[0]).toContain(
    "人物引用未匹配",
  );
  expect((await jobs(page))[0]).toMatchObject({
    sourceModelId: "lm-studio",
    worldbookOmitted: 1,
  });
});
