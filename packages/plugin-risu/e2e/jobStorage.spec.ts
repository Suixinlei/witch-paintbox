import { test, expect, type Page } from "@playwright/test";

async function seedLegacyJobs(page: Page, failures = 0) {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  return page.evaluate(async (remaining) => {
    const settings = JSON.parse(
      window.harness.rawSnapshot().files["automatic-config"],
    );
    settings.execution = "paintbox";
    const records = Array.from({ length: 120 }, (_, index) => ({
      id: "stored-" + index,
      createdAt: index + 1,
      settings,
      pair: { userMessage: "USER", assistantMessage: "正文。".repeat(200) },
      source: {
        character: "角色 A",
        chat: "E2E 聊天",
        characterId: "char-A",
        chatId: "chat-A",
        characterIndex: 0,
        chatIndex: 0,
      },
      state: "ready",
      eventKey: "event-" + Math.floor(index / 3),
      manual: false,
      messageId: "reply-" + Math.floor(index / 3),
      messageIndex: 3,
      libraryRevision: 1,
      savedLibrary: { people: [], backgrounds: [] },
      files: [],
      illustrationBatch: "batch-" + Math.floor(index / 3),
      illustrationOrder: index % 3,
      illustration: {
        at: "3",
        offset: 3,
        summary: "待点击配图",
        prompt: "garden",
        characters: [],
      },
      prompt: "garden",
      awaitingClick: true,
      summaryAttached: true,
      modelRequestState: "complete",
    }));
    const original = JSON.stringify(records);
    await window.risuai.writeServerFile("automatic-jobs", original);
    window.harness.failWrites("automatic-jobs", remaining);
    return original.length;
  }, failures);
}

test("legacy pending plans migrate to shared immutable contexts and survive reload without resubmission", async ({
  page,
}) => {
  const originalBytes = await seedLegacyJobs(page, 1);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(window.harness.rawSnapshot().files["automatic-jobs"])
            .version,
      ),
    )
    .toBe(2);
  const saved = await page.evaluate(() => ({
    raw: window.harness.rawSnapshot(),
    logical: window.harness.snapshot(),
  }));
  const index = JSON.parse(saved.raw.files["automatic-jobs"]);
  expect(index.jobs).toHaveLength(120);
  expect(saved.raw.files["automatic-jobs"].length).toBeLessThan(
    originalBytes / 3,
  );
  expect(
    Object.keys(saved.raw.files).filter((name) =>
      name.startsWith("automatic-context-"),
    ),
  ).toHaveLength(1);
  expect(index.jobs[0].settings).toBeUndefined();
  const records = JSON.parse(saved.logical.files["automatic-jobs"]);
  expect(
    records.every((job: { awaitingClick: boolean }) => job.awaitingClick),
  ).toBe(true);
  expect(records[0].settings.execution).toBe("paintbox");
  expect(records[0].pair.assistantMessage).toBe("正文。".repeat(200));
  const contextWrites = saved.raw.calls.filter(
    (call) =>
      call.kind === "write" &&
      String(call.payload).startsWith("automatic-context-"),
  ).length;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.harness
            .rawSnapshot()
            .calls.filter(
              (call) =>
                call.kind === "write" && call.payload === "automatic-jobs",
            ).length,
      ),
    )
    .toBeGreaterThan(
      saved.raw.calls.filter(
        (call) => call.kind === "write" && call.payload === "automatic-jobs",
      ).length,
    );
  const reloaded = await page.evaluate(() => window.harness.rawSnapshot());
  expect(
    reloaded.calls.filter(
      (call) =>
        call.kind === "write" &&
        String(call.payload).startsWith("automatic-context-"),
    ).length,
  ).toBe(contextWrites);
  expect(
    reloaded.calls.filter((call) =>
      ["model", "novelai", "paintbox", "alert"].includes(call.kind),
    ),
  ).toHaveLength(0);
});

test("a persistent recovery write failure keeps the plugin open and the original plans recoverable", async ({
  page,
}) => {
  await seedLegacyJobs(page, 2);
  const original = await page.evaluate(
    () => window.harness.rawSnapshot().files["automatic-jobs"],
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("任务恢复暂缓");
  const failed = await page.evaluate(() => window.harness.rawSnapshot());
  expect(failed.files["automatic-jobs"]).toBe(original);
  expect(
    failed.calls.filter((call) =>
      ["model", "novelai", "paintbox", "alert"].includes(call.kind),
    ),
  ).toHaveLength(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(window.harness.rawSnapshot().files["automatic-jobs"])
            .version,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(window.harness.snapshot().files["automatic-jobs"]).length,
    ),
  ).toBe(120);
});
