import { test, expect, type Page } from "@playwright/test";

async function seedLegacyJobs(page: Page, failures = 0) {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
  ).toBeVisible();
  return page.evaluate(async (remaining) => {
    const records = Array.from({ length: 120 }, (_, index) => ({
      id: "stored-" + index,
      createdAt: index + 1,
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
      files: [],
      illustrationBatch: "batch-" + Math.floor(index / 3),
      illustrationOrder: index % 3,
      illustration: {
        at: "3",
        offset: 3,
        summary: "待点击配图",
        prompt: "garden",
      },
      awaitingClick: true,
      summaryAttached: true,
      modelRequestState: "complete",
      // Records written before 2.6.0 repeated the plugin's local settings in every job.
      settings: { execution: "paintbox", system: "S".repeat(800) },
    }));
    const original = JSON.stringify(records);
    await window.risuai.writeServerFile("automatic-jobs", original);
    window.harness.failWrites("automatic-jobs", remaining);
    return original.length;
  }, failures);
}

test("stored array plans migrate to shared immutable contexts and survive reload without resubmission", async ({
  page,
}) => {
  const originalBytes = await seedLegacyJobs(page, 1);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
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
  expect(index.jobs[0].settings).toBeUndefined();
  expect(saved.raw.files["automatic-jobs"].length).toBeLessThan(
    originalBytes / 3,
  );
  expect(
    Object.keys(saved.raw.files).filter((name) =>
      name.startsWith("automatic-context-"),
    ),
  ).toHaveLength(1);
  const records = JSON.parse(saved.logical.files["automatic-jobs"]);
  expect(
    records.every((job: { awaitingClick: boolean }) => job.awaitingClick),
  ).toBe(true);
  expect(records[0].pair.assistantMessage).toBe("正文。".repeat(200));
  // A snapshot written here holds the reply and nothing else.
  const snapshotName = Object.keys(saved.raw.files).find((name) =>
    name.startsWith("automatic-context-"),
  )!;
  expect(JSON.parse(saved.raw.files[snapshotName])).toEqual({
    pair: { userMessage: "USER", assistantMessage: "正文。".repeat(200) },
  });
  const contextWrites = saved.raw.calls.filter(
    (call) =>
      call.kind === "write" &&
      String(call.payload).startsWith("automatic-context-"),
  ).length;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
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
      ["paintbox", "fetch", "alert"].includes(call.kind),
    ),
  ).toHaveLength(0);
});

test("a snapshot that also carries settings stays in use as it is", async ({ page }) => {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
  ).toBeVisible();
  const ref = "a".repeat(64);
  const context = await page.evaluate(
    async ({ ref, context }) => {
      await window.risuai.writeServerFile("automatic-context-" + ref, context);
      await window.risuai.writeServerFile(
        "automatic-jobs",
        JSON.stringify({
          version: 2,
          jobs: [
            {
              id: "stored-0",
              contextRef: ref,
              createdAt: 1,
              source: {
                character: "角色 A",
                chat: "E2E 聊天",
                characterId: "char-A",
                chatId: "chat-A",
                characterIndex: 0,
                chatIndex: 0,
              },
              state: "ready",
              eventKey: "event-0",
              manual: false,
              messageId: "reply-0",
              messageIndex: 3,
              files: [],
              illustration: {
                at: "3",
                offset: 3,
                summary: "待点击配图",
                prompt: "garden",
              },
              awaitingClick: true,
              summaryAttached: true,
              modelRequestState: "complete",
            },
          ],
        }),
      );
      return context;
    },
    {
      ref,
      // An older snapshot repeats the plugin's local settings next to the reply.
      context: JSON.stringify({
        settings: { execution: "paintbox", system: "S".repeat(800) },
        pair: { userMessage: "USER", assistantMessage: "回复正文" },
      }),
    },
  );
  const seeded = await page.evaluate(
    () => window.harness.rawSnapshot().calls.length,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
  ).toBeVisible();
  // Recovery saves the index; the old snapshot is neither rewritten nor duplicated.
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
    .toBeGreaterThan(1);
  const saved = await page.evaluate(() => window.harness.rawSnapshot());
  expect(
    Object.keys(saved.files).filter((name) =>
      name.startsWith("automatic-context-"),
    ),
  ).toEqual(["automatic-context-" + ref]);
  expect(saved.files["automatic-context-" + ref]).toBe(context);
  expect(JSON.parse(saved.files["automatic-jobs"]).jobs[0]).toMatchObject({
    contextRef: ref,
    state: "ready",
  });
  expect(
    saved.calls
      .slice(seeded)
      .filter(
        (call) =>
          call.kind === "write" &&
          String(call.payload).startsWith("automatic-context-"),
      ),
  ).toHaveLength(0);
});

test("automatic ready jobs keep their automatic mode after reload", async ({
  page,
}) => {
  await seedLegacyJobs(page);
  await page.evaluate(async () => {
    const records = JSON.parse(
      window.harness.rawSnapshot().files["automatic-jobs"],
    );
    for (const job of records) job.awaitingClick = false;
    await window.risuai.writeServerFile(
      "automatic-jobs",
      JSON.stringify(records),
    );
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
  ).toBeVisible();
  const records = await page.evaluate(() =>
    JSON.parse(window.harness.snapshot().files["automatic-jobs"]),
  );
  expect(records).toHaveLength(120);
  expect(
    records.every(
      (job: { awaitingClick: boolean }) => job.awaitingClick === false,
    ),
  ).toBe(true);
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
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("任务恢复暂缓");
  const failed = await page.evaluate(() => window.harness.rawSnapshot());
  expect(failed.files["automatic-jobs"]).toBe(original);
  expect(
    failed.calls.filter((call) =>
      ["paintbox", "fetch", "alert"].includes(call.kind),
    ),
  ).toHaveLength(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "魔女画匣", exact: true }),
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
