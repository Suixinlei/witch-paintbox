import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GenerationSettings,
  Library,
  ScenePlan,
  Workflow,
} from "../src/domain/types";

test.skip(true, "旧主模型绘图块与 ComfyUI 实图流程");

const directory = process.env.RISU_PLUGIN_LIVE_COPY;
test("复制会话：真实主模型选镜头、统一姓名并提交一张隔离验收图", async ({
  page,
}) => {
  test.skip(!directory, "仅在显式提供隔离会话副本时运行真实模型和生图");
  test.setTimeout(300000);
  const run = directory!;
  const input = JSON.parse(
    await readFile(path.join(run, "live-input.json"), "utf8"),
  ) as {
    observerName: string;
    connection: { url: string; key: string; internalId: string; name: string };
    settings: GenerationSettings;
    library: Library;
    previousReply: string;
    testUser: string;
    source: { messageCount: number; cloneChatId: string };
  };
  await page.goto("/e2e/fixture/");
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  await page.evaluate(
    (serialized) => {
      const data = JSON.parse(serialized) as {
        observerName: string;
        settings: GenerationSettings;
        library: Library;
      };
      window.harness.seedLibrary();
      window.harness.observerName(data.observerName);
      window.harness.editLibrary(data.library);
      window.harness.configure(data.settings);
    },
    JSON.stringify({
      observerName: input.observerName,
      settings: input.settings,
      library: input.library,
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "全局生图 · 两步流程" }),
  ).toBeVisible();
  const injected = await page.evaluate(() => window.harness.inject());
  const worldbook = injected.at(-1)!.content;
  expect(worldbook).toContain("插画协议 v2");
  await writeFile(path.join(run, "injected-worldbook.txt"), worldbook);
  let response: string;
  try {
    response = await readFile(
      path.join(run, "main-model-response.txt"),
      "utf8",
    );
  } catch {
    const result = await fetch(input.connection.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + input.connection.key,
      },
      signal: AbortSignal.timeout(150000),
      body: JSON.stringify({
        model: input.connection.internalId,
        stream: false,
        max_tokens: 6000,
        messages: [
          {
            role: "system",
            content:
              "Continue the supplied fictional scene in Chinese. Keep this turn a calm, non-explicit sleeping scene. Use the supplied state and illustration protocol.",
          },
          { role: "assistant", content: input.previousReply },
          { role: "user", content: input.testUser },
          { role: "system", content: worldbook },
        ],
      }),
    });
    expect(result.ok, "真实主模型 HTTP 状态").toBe(true);
    const body = (await result.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    response = body.choices?.[0]?.message?.content ?? "";
    await writeFile(path.join(run, "main-model-response.txt"), response);
  }
  expect(response).toContain("<image_prompt>");
  await page.evaluate((value) => window.harness.emitRaw(value), response);
  await expect
    .poll(
      async () => {
        const saved = await page.evaluate(() => window.harness.snapshot());
        const job = JSON.parse(saved.files["automatic-jobs"] ?? "[]")[0] as
          | { state: string; error?: string }
          | undefined;
        if (job?.state === "error") throw Error(job.error);
        return job?.state;
      },
      { timeout: 15000 },
    )
    .toBe("complete");
  const saved = await page.evaluate(() => window.harness.snapshot());
  const job = JSON.parse(saved.files["automatic-jobs"])[0] as {
    plan: ScenePlan;
    prompt: string;
    modelCallCount: number;
  };
  await writeFile(
    path.join(run, "compiled-plan.json"),
    JSON.stringify(job.plan, null, 2),
  );
  await writeFile(path.join(run, "final-prompt.txt"), job.prompt);
  expect(job.plan.view.mode).toBe("third_person");
  expect(job.plan.view.visibleBodyParts).toBe("");
  expect(job.plan.characters).toHaveLength(2);
  expect(job.modelCallCount).toBe(0);
  expect(job.prompt).not.toContain("{{person:");
  expect(job.prompt).not.toContain("First-person view through");
  expect(job.plan.composition).toContain(input.observerName);
  expect(job.plan.composition).toContain(
    job.plan.characters.find((person) => person.name !== input.observerName)!
      .name,
  );
  const canonicalPerson = job.plan.characters.find(
    (person) => person.id !== null,
  )!.name;
  expect(job.plan.view.reason.replaceAll(canonicalPerson, "")).not.toMatch(
    /\bMizuho\b/,
  );
  expect(
    saved.calls.filter((call) => ["deepseek", "model"].includes(call.kind)),
  ).toHaveLength(0);
  const submitted = saved.calls.find(
    (call) =>
      call.kind === "fetch" &&
      (call.payload as { url: string }).url.endsWith("/prompt"),
  )!.payload as { options: { body: string } };
  const workflow = (JSON.parse(submitted.options.body) as { prompt: Workflow })
    .prompt;
  for (const node of Object.values(workflow))
    if (node.class_type === "SaveImage")
      node.inputs.filename_prefix =
        "RisuAI/plugin-isolated-tests/name-view-2.2.1";
  await writeFile(
    path.join(run, "submitted-workflow.json"),
    JSON.stringify(workflow, null, 2),
  );
  const base = input.settings.url.replace(/\/+$/, "");
  let promptId: string;
  try {
    promptId = JSON.parse(
      await readFile(path.join(run, "image-submission.json"), "utf8"),
    ).promptId as string;
  } catch {
    const result = await fetch(base + "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: workflow,
        client_id: "isolated-name-view-2.2.1",
      }),
      signal: AbortSignal.timeout(30000),
    });
    expect(result.ok).toBe(true);
    const body = (await result.json()) as {
      prompt_id?: string;
      error?: unknown;
      node_errors?: Record<string, unknown>;
    };
    expect(body.error).toBeUndefined();
    expect(Object.keys(body.node_errors ?? {})).toHaveLength(0);
    expect(body.prompt_id).toBeTruthy();
    promptId = body.prompt_id!;
    await writeFile(
      path.join(run, "image-submission.json"),
      JSON.stringify({ promptId }),
    );
  }
  let imagePath = "";
  await expect
    .poll(
      async () => {
        const result = await fetch(base + "/history/" + promptId, {
          signal: AbortSignal.timeout(30000),
        });
        const body = (await result.json()) as Record<
          string,
          {
            status?: { status_str?: string };
            outputs?: Record<
              string,
              {
                images?: {
                  filename: string;
                  subfolder: string;
                  type: string;
                }[];
              }
            >;
          }
        >;
        const history = body[promptId];
        if (history?.status?.status_str === "error")
          throw Error("ComfyUI execution failed");
        const file = Object.values(history?.outputs ?? {}).flatMap(
          (node) => node.images ?? [],
        )[0];
        if (!file) return false;
        const image = await fetch(base + "/view?" + new URLSearchParams(file), {
          signal: AbortSignal.timeout(30000),
        });
        imagePath = path.join(run, "result.png");
        await writeFile(imagePath, Buffer.from(await image.arrayBuffer()));
        return true;
      },
      { timeout: 180000, intervals: [3000] },
    )
    .toBe(true);
  await writeFile(
    path.join(run, "verification.json"),
    JSON.stringify(
      {
        sourceMessageCount: input.source.messageCount,
        cloneChatId: input.source.cloneChatId,
        mainModel: input.connection.name,
        modelRequests: 1,
        auxiliaryRequests: 0,
        mode: job.plan.view.mode,
        reason: job.plan.view.reason,
        people: job.plan.characters.map((person) => ({
          id: person.id,
          name: person.name,
        })),
        observerName: job.plan.view.observerName,
        placeholdersResolved: true,
        promptId,
        imagePath,
        sourceWrites: 0,
        scope:
          "完整会话已复制到本地隔离文件；真实主模型请求使用末轮入睡片段和插件动态规则，完整插件在隔离宿主编译，使用同一工作流真实生图。",
      },
      null,
      2,
    ),
  );
});
