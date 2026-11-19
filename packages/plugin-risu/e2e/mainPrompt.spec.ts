import { test, expect, type Page } from "@playwright/test";
import type { Library } from "../src/domain/types";

test.skip(true, "旧主模型绘图块协议，已由 NovelAI 楼层配图替代");

const library: Library = {
  revision: 1,
  people: [
    {
      id: "lin",
      name: "示例人物",
      appearance: "LIN_FIXED_FACE",
      defaultOutfitId: "old",
      outfits: [{ id: "old", name: "old", description: "OLD_UNIFORM" }],
    },
    { id: "second", name: "第二人物", appearance: "SECOND_FIXED_FACE" },
    { id: "third", name: "第三人物", appearance: "THIRD_FIXED_FACE" },
    { id: "absent", name: "未出场人物", appearance: "ABSENT_FIXED_FACE" },
  ],
  backgrounds: [],
};
function drawing(ids: string[] = ["lin"], mode = "first_person") {
  return {
    version: 1,
    view: {
      mode,
      observerName: "故事观察者",
      reason:
        mode === "third_person" ? "Show the group interaction clearly." : "",
      visibleBodyParts: "",
    },
    scene: {
      backgroundId: null,
      referenceMatch: "none",
      name: "花园",
      description: "A sunlit garden.",
    },
    composition:
      "The named characters stand side by side at natural scale in one scene.",
    characters: ids.map((varId, index) => ({
      varId,
      action: `Standing at position ${index + 1} and looking toward the flowers.`,
      state: "",
      outfit: { mode: "custom", description: `CURRENT_OUTFIT_${varId}` },
    })),
    objects: [],
  };
}
function reply(ids: string[], plan: unknown = drawing(ids)) {
  return (
    "当前场景正文。\n<statusData>u|time:14:30</statusData>\n" +
    ids
      .map(
        (id) =>
          `<statusData>c|varId:${id}|equipment:CURRENT_EQUIPMENT_${id}<br>shoes|status:平静</statusData>`,
      )
      .join("\n") +
    `\n<details><summary>绘图描述</summary><image_prompt>${JSON.stringify(plan)}</image_prompt></details>`
  );
}
async function seed(page: Page) {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate((data) => {
    window.harness.editLibrary(JSON.parse(data));
    window.harness.configure({ enabled: true, mainModelPrompt: true });
  }, JSON.stringify(library));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
}
async function jobs(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(window.harness.snapshot().files["automatic-jobs"] ?? "[]") as {
        state: string;
        prompt: string;
        modelCallCount: number;
        error?: string;
        raw?: string;
        attachmentState?: string;
      }[],
  );
}
async function finish(page: Page, state = "complete") {
  await expect.poll(async () => (await jobs(page)).at(-1)?.state).toBe(state);
  if (state === "complete")
    await expect
      .poll(async () => (await jobs(page)).at(-1)?.attachmentState)
      .toBe("attached");
  const snapshot = await page.evaluate(() => window.harness.snapshot());
  expect(
    snapshot.calls.filter((call) => ["deepseek", "model"].includes(call.kind)),
  ).toHaveLength(0);
  return snapshot;
}
function drawingV2(ids: string[], mode = "first_person") {
  const value = drawing(ids, mode);
  value.version = 2;
  value.composition =
    ids.map((id) => `{{person:${id}}}`).join(" and ") +
    " share one coherent scene.";
  return value;
}
test("v2统一姓名引用，varId与状态栏大小写兼容，保留资料ID", async ({
  page,
}) => {
  await seed(page);
  const value = drawingV2(["LiN", "SeCoNd"]);
  value.characters[0].action =
    "{{person:LIN}} offers a cup to {{person:SECOND}} while {{person:$OBSERVER}} watches.";
  await page.evaluate(
    (data) => window.harness.emitRaw(data),
    reply(["LIN", "second"], value),
  );
  await finish(page);
  const job = (await jobs(page))[0];
  expect(job.prompt).toContain(
    "示例人物 and 第二人物 share one coherent scene.",
  );
  expect(job.prompt).toContain(
    "示例人物 offers a cup to 第二人物 while 故事观察者 watches.",
  );
  expect(job.prompt).not.toContain("{{person:");
  expect(
    JSON.parse(job.raw!).characters.map((person: { id: string }) => person.id),
  ).toEqual(["lin", "second"]);
});
test("v2单名角色与用户相拥允许第三人称，用户入画计数", async ({ page }) => {
  await seed(page);
  const value = drawingV2(["lin", "$OBSERVER"], "third_person");
  value.view.reason =
    "Their sleeping embrace is not clearly visible from {{person:$observer}}'s own eyes.";
  value.composition =
    "Side view of {{person:LIN}} and {{person:$observer}} lying side by side under a quilt.";
  value.characters[0].action =
    "Sleeping with the face nestled against {{person:$observer}}'s neck.";
  await page.evaluate(
    (data) => window.harness.emitRaw(data),
    reply(["LiN"], value),
  );
  await finish(page);
  const prompt = (await jobs(page))[0].prompt;
  expect(prompt).toContain("Third-person narrative illustration.");
  expect(prompt).toContain("Side view of 示例人物 and 故事观察者");
  expect(prompt).toContain("2 listed visible characters");
  expect(prompt).not.toContain("First-person view through");
});
test("已知简称在reason与动作中还原统一姓名，不重复展开括号内英文名", async ({
  page,
}) => {
  await seed(page);
  const saved = structuredClone(library);
  saved.people[0] = {
    id: "mizuho",
    name: "三枝瑞穗（Saegusa Mizuho）",
    appearance: "FIXED_APPEARANCE",
  };
  saved.people.push({
    id: "USER",
    name: "故事观察者（Viewer A）",
    appearance: "OBSERVER_FACE",
  });
  await page.evaluate(
    (data) => window.harness.editLibrary(JSON.parse(data)),
    JSON.stringify(saved),
  );
  const value = drawingV2(["MIZUHO", "$observer"], "third_person");
  value.view.reason =
    "Mizuho rests against Viewer A, so use an external angle.";
  value.characters[0].action = "Mizuho rests beside {{person:$observer}}.";
  await page.evaluate(
    (data) => window.harness.emitRaw(data),
    reply(["Mizuho"], value),
  );
  await finish(page);
  const plan = JSON.parse((await jobs(page))[0].raw!);
  expect(plan.view.reason).toBe(
    "三枝瑞穗（Saegusa Mizuho） rests against 故事观察者, so use an external angle.",
  );
  expect(plan.characters[0].action).toBe(
    "三枝瑞穗（Saegusa Mizuho） rests beside 故事观察者.",
  );
  expect(plan.composition).toBe(
    "三枝瑞穗（Saegusa Mizuho） and 故事观察者 share one coherent scene.",
  );
});
for (const [label, make, statusIds, error] of [
  [
    "构图未使用统一引用",
    () => ({ ...drawingV2(["lin"]), composition: "Lin stands alone." }),
    ["lin"],
    "构图必须使用统一人物引用",
  ],
  [
    "引用画外人物",
    () => ({
      ...drawingV2(["lin"]),
      composition: "{{person:lin}} talks to {{person:absent}}.",
    }),
    ["lin"],
    "未入画或未知人物",
  ],
  ["大小写重复入画", () => drawingV2(["lin", "LIN"]), ["lin"], "绘图人物重复"],
  ["大小写重复状态", () => drawingV2(["lin"]), ["lin", "LIN"], "在场人物重复"],
  [
    "第三人称残留局部字段",
    () => {
      const value = drawingV2(["lin"], "third_person");
      value.view.visibleBodyParts = "an arm";
      return value;
    },
    ["lin"],
    "第三人称应清空",
  ],
  [
    "第三人称遗漏入画用户",
    () => ({
      ...drawingV2(["lin"], "third_person"),
      composition: "{{person:lin}} embraces {{person:$observer}}.",
    }),
    ["lin"],
    "观察者必须列入",
  ],
] as const) {
  test(`v2引用与视角校验：${label}`, async ({ page }) => {
    await seed(page);
    await page.evaluate(
      (data) => window.harness.emitRaw(data),
      reply([...statusIds], make()),
    );
    const snapshot = await finish(page, "error");
    expect(snapshot.submissions).toBe(0);
    expect((await jobs(page))[0].error).toContain(error);
  });
}
test("仅大小写不同的资料映射不能静默选中", async ({ page }) => {
  await seed(page);
  const conflict = structuredClone(library);
  conflict.people[1].varId = "LIN";
  await page.evaluate(
    (data) => window.harness.editLibrary(JSON.parse(data)),
    JSON.stringify(conflict),
  );
  await page.evaluate(
    (data) => window.harness.emitRaw(data),
    reply(["lin"], drawingV2(["lin"])),
  );
  const snapshot = await finish(page, "error");
  expect(snapshot.submissions).toBe(0);
  expect((await jobs(page))[0].error).toContain("映射重复");
});
test("背景与服装引用忽略大小写，最终计划还原资料ID", async ({ page }) => {
  await seed(page);
  const saved = structuredClone(library);
  saved.backgrounds = [
    { id: "CafeRoom", name: "咖啡厅", description: "FIXED_CAFE_ROOM" },
  ];
  await page.evaluate(
    (data) => window.harness.editLibrary(JSON.parse(data)),
    JSON.stringify(saved),
  );
  const value = {
    ...drawingV2(["LIN"]),
    scene: {
      backgroundId: "caFEROOM",
      referenceMatch: "exact",
      name: "咖啡厅",
      description: "A quiet cafe.",
    },
    characters: [
      {
        varId: "LIN",
        action: "Sitting beside the table.",
        outfit: { mode: "reference", id: "OLD" },
      },
    ],
  };
  const data = reply(["LiN"], value).replace(
    "CURRENT_EQUIPMENT_LiN<br>shoes",
    "",
  );
  await page.evaluate((text) => window.harness.emitRaw(text), data);
  await finish(page);
  const job = (await jobs(page))[0];
  const plan = JSON.parse(job.raw!);
  expect(plan.scene.backgroundId).toBe("caFEROOM");
  expect(job.prompt).toContain("FIXED_CAFE_ROOM");
  expect(job.prompt).toContain("Outfit: OLD_UNIFORM");
  // The persisted final plan uses canonical reference IDs, not the model's casing.
  const finalPlan = await page.evaluate(
    () =>
      JSON.parse(window.harness.snapshot().files["automatic-jobs"])[0].plan as {
        scene: { backgroundId: string };
        characters: { id: string; outfit: { id: string } }[];
      },
  );
  expect(finalPlan.scene.backgroundId).toBe("CafeRoom");
  expect(finalPlan.characters[0].outfit.id).toBe("old");
});
for (const ids of [
  [],
  ["lin"],
  ["lin", "second"],
  ["lin", "second", "third"],
]) {
  test(`本轮状态栏限制人数，零额外模型请求：${ids.length}人`, async ({
    page,
  }) => {
    await seed(page);
    const data = reply(ids);
    await page.evaluate((value) => window.harness.emitRaw(value), data);
    await page.evaluate((value) => window.harness.emitRaw(value), data);
    const snapshot = await finish(page);
    expect(snapshot.submissions).toBe(1);
    const [job] = await jobs(page);
    expect(job.prompt).toContain(`${ids.length} listed visible characters`);
    expect(job.modelCallCount).toBe(0);
    expect(job.prompt).not.toContain("ABSENT_FIXED_FACE");
    expect(job.prompt).not.toContain("OLD_UNIFORM");
    for (const id of ids) {
      expect(job.prompt).toContain(`CURRENT_OUTFIT_${id}`);
      expect(job.prompt).toContain(`CURRENT_EQUIPMENT_${id}; shoes`);
    }
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "全局生图 · 两步流程" }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => window.harness.snapshot())).submissions,
    ).toBe(1);
  });
}
test("在场三人只画两人，离场人物不沿用上一轮", async ({ page }) => {
  await seed(page);
  await page.evaluate(
    (value) => window.harness.emitRaw(value),
    reply(["lin", "second", "third"], drawing(["lin", "second"])),
  );
  await finish(page);
  expect((await jobs(page))[0].prompt).not.toContain("THIRD_FIXED_FACE");
  await page.evaluate(
    (value) => window.harness.emitRaw(value, "reply-2"),
    reply(["third"]),
  );
  await finish(page);
  const prompt = (await jobs(page)).at(-1)!.prompt;
  expect(prompt).toContain("THIRD_FIXED_FACE");
  expect(prompt).not.toContain("LIN_FIXED_FACE");
});
for (const [label, data, error] of [
  ["不在场人物", reply(["lin"], drawing(["second"])), "不在本轮在场名单"],
  ["重复人物", reply(["lin"], drawing(["lin", "lin"])), "绘图人物重复"],
  ["未知人物", reply(["unknown"]), "尚未绑定资料"],
  [
    "缺少状态栏",
    `<image_prompt>${JSON.stringify(drawing())}</image_prompt>`,
    "缺少完整 statusData",
  ],
  [
    "缺少绘图块",
    "正文<statusData>u|time:14:30</statusData>",
    "一个完整 image_prompt",
  ],
  [
    "不完整绘图块",
    reply(["lin"]).replace("</image_prompt>", ""),
    "一个完整 image_prompt",
  ],
  [
    "损坏JSON",
    reply(["lin"]).replace('"version":1', '"version":'),
    "不是完整 JSON",
  ],
  ["第一人称重复观察者", reply([], drawing(["$observer"])), "第一人称视角不能"],
  ["重复状态块", reply(["lin", "lin"]), "在场人物重复"],
  [
    "缺少用户状态",
    reply(["lin"]).replace("<statusData>u|time:14:30</statusData>", ""),
    "一个用户 u",
  ],
] as const) {
  test(`协议错误停止，不回退辅助模型：${label}`, async ({ page }) => {
    await seed(page);
    await page.evaluate((value) => window.harness.emitRaw(value), data);
    const snapshot = await finish(page, "error");
    expect(snapshot.submissions).toBe(0);
    expect((await jobs(page))[0].error).toContain(error);
  });
}
test("varId显式绑定原资料ID，第三人称支持观察者入画", async ({ page }) => {
  await seed(page);
  const mapped = structuredClone(library);
  mapped.people[0].varId = "status_lin";
  await page.evaluate(
    (value) => window.harness.editLibrary(JSON.parse(value)),
    JSON.stringify(mapped),
  );
  await page.evaluate(
    (value) => window.harness.emitRaw(value),
    reply(["status_lin"], drawing(["status_lin", "$observer"], "third_person")),
  );
  await finish(page);
  expect((await jobs(page))[0].prompt).toContain("LIN_FIXED_FACE");
  expect((await jobs(page))[0].prompt).toContain("2 listed visible characters");
});
test("规则动态注入最新索引，辅助请求跳过，卸载移除", async ({ page }) => {
  await seed(page);
  const messages = await page.evaluate(() => window.harness.inject());
  expect(messages).toHaveLength(2);
  expect(messages[1].content).toContain("不限人数");
  expect(messages[1].content).toContain('"varId":"lin"');
  expect(messages[1].content).not.toContain("LIN_FIXED_FACE");
  expect(
    await page.evaluate(() => window.harness.inject("submodel")),
  ).toHaveLength(1);
  await page.evaluate(() => window.harness.unload());
  expect(await page.evaluate(() => window.harness.inject())).toHaveLength(0);
});
test("预览复用本轮绘图块，手动重画读取原始状态栏", async ({ page }) => {
  await seed(page);
  await page.evaluate(
    (value) => window.harness.emitRaw(value),
    reply(["lin", "second"]),
  );
  await finish(page);
  await page
    .getByRole("button", { name: "第二步 · 自动生图", exact: true })
    .click();
  await page
    .getByRole("button", { name: "预览本轮构图 JSON（不生图）", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "构图 JSON 预览" }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.harness.snapshot())).submissions,
  ).toBe(1);
  const result = await page.evaluate(() => window.harness.request());
  // The fixture request carries old text, so raw recovery must reject it.
  expect(result?.accepted).toBe(false);
  expect(result?.reason).toContain("原回复已变化");
  const accepted = await page.evaluate(() =>
    window.harness.request("regenerate", true),
  );
  expect(accepted?.accepted).toBe(true);
  const snapshot = await finish(page);
  expect(snapshot.submissions).toBe(2);
  expect((await jobs(page)).at(-1)?.prompt).toContain(
    "2 listed visible characters",
  );
});
