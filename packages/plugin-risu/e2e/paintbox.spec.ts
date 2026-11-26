import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { GenerationJob } from "../src/domain/types";

const fakeToken = "fixture-consumer-token-0000";
const line = "A red paper boat floats across a lake under a sunrise.";
const reply = `${line}\r\n\r\n<think>\r\nHIDDEN\r\n</think>\r\n\r\nThe pines reflect in the water.`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ywAAAAASUVORK5CYII=",
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

async function installFixture(page: Page) {
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "魔女画匣 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.harness.configure({
      execution: "paintbox",
      enabled: false,
    }),
  );
  await page.reload();
  await page.getByLabel("Risu 专用服务令牌").fill(fakeToken);
  await page.getByRole("button", { name: "测试并保存服务连接" }).click();
  await expect(
    page.getByText("已连接魔女画匣独立服务", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("button")).toHaveText([
    "服务连接",
    "配图",
    "生图回顾",
  ]);
  await expect(page.getByLabel("助手回复完成后自动配图")).toHaveCount(0);
}

test("Risu persists summaries without drawing until the selected summary is clicked", async ({
  page,
}) => {
  await page.route("**/e2e-paintbox/v1/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1);
    if (endpoint === "health")
      return route.fulfill({ json: { version: 3, revision: "configured" } });
    if (endpoint === "preferences")
      return route.fulfill({ json: { enabled: true } });
    const body = route.request().postDataJSON();
    if (endpoint === "plan") {
      expect(body.original).not.toContain("HIDDEN");
      expect(body.maxImages).toBeUndefined();
      expect(body.risu).toEqual({ cardId: "char-A", automatic: true });
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
    expect(body.input).toEqual({ scene: "red paper boat, lake" });
    return route.fulfill({
      contentType,
      body: packet({ history: { id: body.history.id } }, [png]),
    });
  });
  await installFixture(page);
  await page.evaluate((text) => {
    window.harness.emitRaw(text);
    window.harness.emitRaw(text);
  }, reply);
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(1);
  const [original, second] = await jobs(page);
  expect(original).toMatchObject({
    awaitingClick: true,
    summaryAttached: true,
    files: [],
  });
  const state = await snapshot(page);
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
  expect(state.files[`automatic-image-${original.id}-0`]).toBeUndefined();
  expect(state.files[`automatic-image-${second.id}-0`]).toBeUndefined();
  expect(
    state.calls.filter(
      ({ kind, payload }) =>
        kind === "paintbox" &&
        (payload as { path?: string }).path === "/v1/images",
    ),
  ).toHaveLength(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "服务连接", exact: true }),
  ).toBeVisible();
  await page.evaluate((text) => window.harness.emitRaw(text), reply);
  await expect.poll(async () => (await jobs(page)).length).toBe(2);
  expect(
    (await snapshot(page)).calls.filter(
      ({ kind, payload }) =>
        kind === "paintbox" &&
        (payload as { path?: string }).path === "/v1/images",
    ),
  ).toHaveLength(0);
  expect(
    await page.evaluate(
      (id) => window.harness.request("regenerate", true, id),
      `${original.id}:0`,
    ),
  ).toMatchObject({ accepted: true });
  await expect
    .poll(async () => (await snapshot(page)).attachments.length)
    .toBe(2);
  const finished = await snapshot(page);
  expect(finished.attachments[1]).toMatchObject({
    replaceImageIds: expect.arrayContaining([`${original.id}:0`]),
  });
  expect(finished.attachments[1]).not.toMatchObject({
    replaceImageIds: expect.arrayContaining([`${second.id}:0`]),
  });
  const requests = finished.calls
    .filter(({ kind }) => kind === "paintbox")
    .map(({ payload }) => payload as { path: string });
  expect(
    requests.filter((request) => request.path === "/v1/plan"),
  ).toHaveLength(1);
  expect(
    requests.filter((request) => request.path === "/v1/images"),
  ).toHaveLength(1);
  expect((await jobs(page)).find((job) => job.id === second.id)).toMatchObject({
    awaitingClick: true,
    files: [],
  });
  expect(
    finished.calls.filter(({ kind }) => ["model", "novelai"].includes(kind)),
  ).toEqual([]);
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
  await expect
    .poll(async () => (await jobs(page)).some((job) => job.awaitingClick), {
      timeout: 120_000,
    })
    .toBe(true);
  const planned = (await jobs(page)).find((job) => job.awaitingClick)!;
  await page.evaluate(
    (id) => window.harness.request("regenerate", true, id),
    planned.id + ":0",
  );
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
