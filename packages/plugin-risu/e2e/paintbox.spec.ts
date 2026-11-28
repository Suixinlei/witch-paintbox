import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { GenerationJob } from "../src/domain/types";

const fakeToken = "fixture-consumer-token-0000";
const line = "A red paper boat floats across a lake under a sunrise.";
const reply = `${line}\r\n\r\n<think>\r\nHIDDEN\r\n</think>\r\n\r\nThe pines reflect in the water.`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ywAAAAASUVORK5CYII=",
  "base64",
);
const contentType = "application/vnd.witch-paintbox.v1";

function packet(value: object, blobs: Buffer[] = []) {
  const manifest = Buffer.from(
    JSON.stringify({
      value,
      blobs: blobs.map(({ length }) => ({ size: length, type: "image/png" })),
    }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifest.length);
  return Buffer.concat([header, manifest, ...blobs]);
}

const snapshot = (page: Page) => page.evaluate(() => window.harness.snapshot());
const jobs = async (page: Page): Promise<GenerationJob[]> =>
  JSON.parse((await snapshot(page)).files["automatic-jobs"] ?? "[]");
/** Request bodies the plugin sent to one service endpoint. */
const requests = async (page: Page, path: string) =>
  (await snapshot(page)).calls
    .filter(
      (call) =>
        call.kind === "paintbox" &&
        (call.payload as { path: string }).path === path,
    )
    .map(
      (call) =>
        (call.payload as { body: Record<string, unknown> }).body as {
          original?: string;
          risu?: { cardId: string; automatic: boolean };
          input?: { scene?: string };
        },
    );

async function mockService(page: Page) {
  await page.route("**/e2e-paintbox/v1/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1);
    if (endpoint === "health")
      return route.fulfill({ json: { version: 3, revision: "configured" } });
    if (endpoint === "preferences")
      return route.fulfill({ json: { enabled: true } });
    // A whole-reply batch attaches every picture at once, so earlier ones are read back.
    if (endpoint === "image") {
      const { id } = route.request().postDataJSON();
      return route.fulfill({
        contentType,
        body: packet({ entries: [{ id }] }, [png]),
      });
    }
    const body = route.request().postDataJSON();
    if (endpoint === "plan") {
      expect(body.original).not.toContain("HIDDEN");
      expect(body.risu.cardId).toBe("char-A");
      expect(body.maxImages).toBeUndefined();
      expect(body.draw).toBeUndefined();
      return route.fulfill({
        contentType,
        body: packet({
          added: [
            {
              start: line.length + 2,
              sourceOffset: line.length + 2,
              summary: "Paper boat",
              prompt: "red paper boat, lake",
            },
            {
              start: reply.length + 60,
              sourceOffset: reply.length,
              summary: "Pine reflections",
              prompt: "pine tree reflections, lake",
            },
          ],
        }),
      });
    }
    expect(endpoint).toBe("images");
    expect(["red paper boat, lake", "pine tree reflections, lake"]).toContain(
      body.input.scene,
    );
    return route.fulfill({
      contentType,
      body: packet({ history: { id: body.history.id } }, [png]),
    });
  });
}

async function installFixture(page: Page) {
  await page.goto("/e2e/fixture/");
  await page.getByLabel("Risu 专用服务令牌").fill(fakeToken);
  await page.getByRole("button", { name: "测试并保存服务连接" }).click();
  await expect(
    page.getByText("已连接魔女画匣独立服务", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("button")).toHaveText([
    "服务连接",
    "配图",
  ]);
}

const attached = (page: Page) =>
  jobs(page).then((list) =>
    list.filter((job) => job.attachmentState === "attached"),
  );

test("Risu automatically draws every planned image once and attaches them after the reply", async ({
  page,
}) => {
  await mockService(page);
  await installFixture(page);
  await page.evaluate((text) => {
    window.harness.emitRaw(text);
    window.harness.emitRaw(text);
  }, reply);
  await expect.poll(async () => (await attached(page)).length).toBe(2);
  const [original, second] = await jobs(page);
  expect(original).toMatchObject({
    awaitingClick: false,
    summaryAttached: true,
    state: "complete",
  });
  expect(second).toMatchObject({ awaitingClick: false, state: "complete" });
  const state = await snapshot(page);
  for (const call of state.calls.filter(({ kind }) => kind === "paintbox")) {
    const request = call.payload as { method: string; retainResult: boolean };
    expect(request.retainResult).toBe(request.method === "POST");
  }
  expect(state.attachments[0]).toMatchObject({
    expectedRawMessageText: reply,
    images: [
      { alt: "Paper boat", offset: line.length, planned: true, path: "" },
      {
        alt: "Pine reflections",
        offset: reply.length,
        planned: true,
        path: "",
      },
    ],
  });
  for (const job of [original, second])
    expect(state.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          replaceImageIds: expect.arrayContaining([job.id + ":0"]),
        }),
      ]),
    );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "服务连接", exact: true }),
  ).toBeVisible();
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect.poll(async () => (await jobs(page)).length).toBe(2);
  const finished = await snapshot(page);
  const plans = await requests(page, "/v1/plan");
  expect(plans).toHaveLength(1);
  expect(plans[0].risu).toEqual({ cardId: "char-A", automatic: true });
  expect(await requests(page, "/v1/images")).toHaveLength(2);
  expect(finished.calls.filter(({ kind }) => kind === "fetch")).toEqual([]);
});

test("regenerating one picture reuses its saved prompt and replaces only that picture", async ({
  page,
}) => {
  await mockService(page);
  await installFixture(page);
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect.poll(async () => (await attached(page)).length).toBe(2);
  const [boat, pines] = await jobs(page);
  const result = await page.evaluate(
    (imageId) => window.harness.request("regenerate", true, imageId),
    boat.id + ":0",
  );
  expect(result).toMatchObject({ accepted: true });
  await expect
    .poll(
      async () =>
        (await jobs(page)).find((job) => job.id === result?.jobId)
          ?.attachmentState,
    )
    .toBe("attached");
  const after = await jobs(page);
  const replacement = after.find((job) => job.id === result?.jobId);
  expect(replacement).toMatchObject({
    state: "complete",
    manual: true,
    retryOf: boat.id,
    replacesImageId: boat.id + ":0",
  });
  expect(after.find((job) => job.id === boat.id)?.supersededBy).toBe(
    replacement?.id,
  );
  expect(
    after.find((job) => job.id === pines.id)?.supersededBy,
  ).toBeUndefined();
  // Only the chosen picture is drawn again, from the prompt saved with it.
  expect(await requests(page, "/v1/plan")).toHaveLength(1);
  const draws = await requests(page, "/v1/images");
  expect(draws).toHaveLength(3);
  expect(draws[2].input?.scene).toBe("red paper boat, lake");
  expect((await snapshot(page)).attachments.at(-1)).toMatchObject({
    replaceImageIds: expect.arrayContaining([
      replacement!.id + ":0",
      boat.id + ":0",
    ]),
  });
});

test("filling the latest reply reuses its finished pictures", async ({
  page,
}) => {
  await mockService(page);
  await installFixture(page);
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect.poll(async () => (await attached(page)).length).toBe(2);
  await page.getByRole("button", { name: "配图", exact: true }).click();
  await page
    .getByRole("button", { name: "为最新已完成回复自动配图（去重）" })
    .click();
  await expect(page.getByRole("status")).toHaveText("已确认最新回复的配图任务");
  expect(await jobs(page)).toHaveLength(2);
  expect(await requests(page, "/v1/plan")).toHaveLength(1);
  expect(await requests(page, "/v1/images")).toHaveLength(2);
});

test("replanning a reply draws a new set and replaces the old pictures in one step", async ({
  page,
}) => {
  await mockService(page);
  await installFixture(page);
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect.poll(async () => (await attached(page)).length).toBe(2);
  const result = await page.evaluate(() =>
    window.harness.request("replace", true),
  );
  expect(result).toMatchObject({ accepted: true });
  await expect
    .poll(
      async () =>
        (await jobs(page)).filter(
          (job) => job.replaceReplyImages && job.attachmentState === "attached",
        ).length,
    )
    .toBe(2);
  const after = await jobs(page);
  expect(after.filter((job) => job.supersededBy)).toHaveLength(2);
  expect(after.filter((job) => !job.supersededBy)).toHaveLength(2);
  const final = await snapshot(page);
  expect(final.attachments.at(-1)).toMatchObject({
    replaceAll: true,
  });
  // The old pictures stay until the new set lands: nothing is ever replaced by an empty list.
  expect(
    final.attachments.every(
      (item) => (item as { images: unknown[] }).images.length > 0,
    ),
  ).toBe(true);
  const plans = await requests(page, "/v1/plan");
  expect(plans).toHaveLength(2);
  expect(plans[1].risu).toEqual({ cardId: "char-A", automatic: false });
  expect(await requests(page, "/v1/images")).toHaveLength(4);
});

test("real Paintbox planning, NovelAI PNG and Risu attachment", async ({
  page,
}) => {
  const token = process.env.RISU_PAINTBOX_LIVE_TOKEN;
  const output = process.env.RISU_PAINTBOX_LIVE_OUTPUT;
  test.skip(
    !token || !output,
    "requires an explicitly enabled local live test",
  );
  test.setTimeout(300_000);
  await page.route("**/e2e-paintbox/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/e2e-paintbox",
      "",
    );
    const response = await fetch("http://127.0.0.1:4783" + path, {
      method: route.request().method(),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: route.request().postData() ?? undefined,
      signal: AbortSignal.timeout(270_000),
    });
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await installFixture(page);
  await page.evaluate((text) => window.harness.emitRaw(text), line);
  let terminal: GenerationJob | undefined;
  await expect
    .poll(
      async () => {
        terminal = (await jobs(page)).find(
          (job) => job.state === "error" || job.attachmentState === "attached",
        );
        return Boolean(terminal);
      },
      { timeout: 260_000 },
    )
    .toBe(true);
  expect(terminal, terminal?.error ?? terminal?.attachmentError).toMatchObject({
    state: "complete",
    attachmentState: "attached",
  });
  expect(terminal?.serviceImageId).toBeTruthy();
  const response = await fetch("http://127.0.0.1:4783/v1/history/image", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: terminal?.serviceImageId }),
  });
  expect(response.ok).toBe(true);
  const bytes = Buffer.from(await response.arrayBuffer());
  const image = bytes.subarray(4 + bytes.readUInt32BE());
  expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  await writeFile(output!, image);
});
