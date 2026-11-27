import { expect, test, type Page } from "@playwright/test";

const fakeToken = "fixture-consumer-token-0000";
const contentType = "application/vnd.witch-paintbox.v1";
// The card's own gate: its status panel only exists on the newest message.
const gate =
  "{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}}}}}}}";
const status = (id: string) =>
  `<statusData>c|varId:${id}|equipment:校服|mode:普通|status:[平静]|affection:20|log:无变动</statusData>`;
const reply = `她推门走进图书室，把借阅册放在桌上。\n\n${status("chenhai")}\n${status("megumi")}`;
const banner =
  "<statusData>u|time:17:35|date:4月22日 周二|weather:黄昏, 晴朗|daysElapsed:16|userGold:318170|userTicket:2|items:学生证</statusData>";

function packet(value: object, blobs: Buffer[]) {
  const manifest = Buffer.from(
    JSON.stringify({
      value,
      blobs: blobs.map(({ length }) => ({
        size: length,
        type: "image/png",
      })),
    }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifest.length);
  return Buffer.concat([header, manifest, ...blobs]);
}

async function solid(page: Page, color: string) {
  await page.setContent(
    `<body style="margin:0;width:4px;height:6px;background:${color}"></body>`,
  );
  return page.screenshot({ clip: { x: 0, y: 0, width: 4, height: 6 } });
}

function rule(id: string, image: Buffer) {
  return (
    `.portrait[data-char="${id}" i]::after,.portrait[data-char^="${id} " i]::after{` +
    'content:"";position:absolute;inset:0;z-index:3;border-radius:7px;' +
    `background-color:#241d33;background-image:url("data:image/png;base64,${image.toString("base64")}");` +
    "background-position:center top;background-size:cover;background-repeat:no-repeat}"
  );
}

async function mockLibrary(page: Page) {
  const images = [await solid(page, "#aa5c72"), await solid(page, "#5c72aa")];
  const library = {
    revision: "library-1",
    // `source` picks the picture; the service sends every portrait with a blob of its own.
    portraits: [
      {
        id: "chenhai",
        name: "镇海（Chen Hai）",
        aliases: ["Zhen Hai"],
        source: 0,
      },
      { id: "megumi", name: "加藤惠（Katou Megumi）", aliases: [], source: 1 },
    ],
  };
  const state = {
    images,
    fail: false,
    // `hold` leaves the request unanswered, like a service that hangs.
    hold: false,
    requests: [] as { cardId: string; revision?: string }[],
  };
  await page.route("**/e2e-paintbox/v1/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1);
    if (endpoint === "health")
      return route.fulfill({ json: { version: 3, revision: "configured" } });
    if (endpoint === "preferences")
      return route.fulfill({ json: { enabled: false } });
    if (endpoint === "portraits") {
      const body = route.request().postDataJSON() as {
        cardId: string;
        revision?: string;
      };
      state.requests.push(body);
      if (state.hold) return new Promise<void>(() => {});
      if (state.fail) return route.abort("connectionfailed");
      if (body.revision === library.revision)
        return route.fulfill({
          json: { revision: library.revision, unchanged: true },
        });
      return route.fulfill({
        contentType,
        body: packet(
          {
            revision: library.revision,
            portraits: library.portraits.map(
              ({ id, name, aliases }, blobIndex) => ({
                id,
                name,
                aliases,
                blobIndex,
              }),
            ),
          },
          library.portraits.map(({ source }) => images[source]),
        ),
      });
    }
    throw Error("Unexpected paintbox endpoint " + endpoint);
  });
  return { state, library };
}

async function openPlugin(page: Page) {
  await page.goto("/e2e/fixture/");
  await page.getByRole("heading", { name: "魔女画匣 · 两步流程" }).waitFor();
  await page.evaluate(() =>
    window.harness.configure({ execution: "paintbox", enabled: false }),
  );
  await page.reload();
}

async function connect(page: Page) {
  await page.getByLabel("Risu 专用服务令牌").fill(fakeToken);
  await page.getByRole("button", { name: "测试并保存服务连接" }).click();
  await expect(
    page.getByText("已连接魔女画匣独立服务", { exact: true }),
  ).toBeVisible();
}

const display = (page: Page, text: string) =>
  page.evaluate((value) => window.harness.display(value), text);

test("paintbox portraits cover every panel character on the newest message", async ({
  page,
}) => {
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  expect(await display(page, reply)).toBe(
    `${reply}\n\n${gate}<style>\n${rule("chenhai", state.images[0])}\n${rule("megumi", state.images[1])}\n</style>{{/}}`,
  );
  expect(state.requests).toEqual([{ cardId: "char-A" }]);
});

test("a character is matched by id, alias or short name and only when it has a portrait", async ({
  page,
}) => {
  const { state, library } = await mockLibrary(page);
  library.portraits = [
    { id: "soda", name: "索达", aliases: [], source: 0 },
    // A name that equals another character's id must not take that id over.
    { id: "maid", name: "soda", aliases: [], source: 1 },
    {
      id: "chenhai",
      name: "镇海（Chen Hai）",
      aliases: ["ZhenHai"],
      source: 1,
    },
    {
      id: "kanashi",
      name: "Kanashi_Hospithera（香奈诗）",
      aliases: [],
      source: 0,
    },
  ];
  await openPlugin(page);
  await connect(page);
  const first = (id: string) => rule(id, state.images[0]);
  const second = (id: string) => rule(id, state.images[1]);
  for (const [id, expected] of [
    ["soda", first],
    ["SODA", first],
    ["maid", second],
    ["ZhenHai", second],
    ["kanashi", first],
    ["Kanashi_Hospithera", first],
  ] as const) {
    expect(await display(page, status(id))).toContain(expected(id));
  }
  // varId is the only value that reaches the CSS, so a portrait can never inject markup or rules.
  expect(await display(page, status('x"}body{display:none}'))).toBeUndefined();
  expect(
    await display(
      page,
      "<statusData>c|equipment:制服|varId:chenhai|mode:普通</statusData>",
    ),
  ).toContain(second("chenhai"));
  expect(await display(page, status("unknown"))).toBeUndefined();
  expect(await display(page, banner)).toBeUndefined();
  expect(await display(page, "她走进图书室。")).toBeUndefined();
  expect(await display(page, "")).toBeUndefined();
  expect(state.requests).toHaveLength(1);
});

test("the library is revalidated by revision and the portraits survive a failing service", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.resume();
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  await display(page, reply);
  await display(page, reply);
  expect(state.requests).toEqual([{ cardId: "char-A" }]);
  await page.clock.fastForward(11_000);
  await display(page, reply);
  expect(state.requests).toEqual([
    { cardId: "char-A" },
    { cardId: "char-A", revision: "library-1" },
  ]);
  state.fail = true;
  await page.clock.fastForward(11_000);
  expect(await display(page, reply)).toContain(
    rule("chenhai", state.images[0]),
  );
  await display(page, reply);
  expect(state.requests).toHaveLength(3);
  state.fail = false;
  await page.clock.fastForward(31_000);
  expect(await display(page, reply)).toContain(rule("megumi", state.images[1]));
  expect(state.requests).toHaveLength(4);
});

test("a card replaced in place gets its own portraits", async ({ page }) => {
  await page.clock.install();
  await page.clock.resume();
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  await display(page, reply);
  await page.evaluate(() => window.harness.recard("char-B"));
  await display(page, reply);
  await page.clock.fastForward(11_000);
  expect(await display(page, reply)).toContain(
    rule("chenhai", state.images[0]),
  );
  expect(state.requests).toEqual([{ cardId: "char-A" }, { cardId: "char-B" }]);
});

test("a service that stops answering costs one short wait, not one per message", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.resume();
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  await display(page, reply);
  state.hold = true;
  await page.clock.fastForward(11_000);
  const waiting = display(page, reply);
  await page.clock.runFor(2600);
  expect(await waiting).toContain(rule("chenhai", state.images[0]));
  expect(await display(page, reply)).toContain(rule("megumi", state.images[1]));
  await page.clock.fastForward(11_000);
  await display(page, reply);
  expect(state.requests).toHaveLength(2);
});

test("nothing is requested without a service connection and the hook is removed on unload", async ({
  page,
}) => {
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await expect(
    page.getByRole("button", { name: "测试并保存服务连接" }),
  ).toBeVisible();
  expect(await display(page, reply)).toBeUndefined();
  await connect(page);
  expect(await display(page, banner)).toBeUndefined();
  expect(await display(page, "她走进图书室。")).toBeUndefined();
  expect(state.requests).toEqual([]);
  await display(page, reply);
  await page.evaluate(() => window.harness.unload());
  expect(await display(page, reply)).toBeUndefined();
});

test("the appended rule covers the panel portrait slot above the card's own image", async ({
  page,
}) => {
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  const styled = (await display(page, reply)) ?? "";
  const appended = styled
    .slice(reply.length)
    .replace(`${gate}<style>\n`, "")
    .replace(/\n<\/style>\{\{\/\}\}$/, "");
  expect(appended).not.toContain("{{");
  // On the newest message the CBS gate evaluates true. Risu then scopes every message style to the
  // chat text and prefixes its classes, for this block and for the card's own stylesheet alike.
  const scoped = (css: string) =>
    css
      .split("}")
      .filter(Boolean)
      .map((part) => {
        const open = part.indexOf("{");
        const selectors = part
          .slice(0, open)
          .split(",")
          .map(
            (selector) =>
              `.chattext ${selector.trim().replace(/\.([a-z-]+)/g, ".x-risu-$1")}`,
          );
        return `${selectors.join(",")}{${part.slice(open + 1)}}`;
      })
      .join("");
  await page.evaluate(
    ({ css, own }) => {
      document.head.innerHTML = `<style>${css}</style>`;
      document.body.innerHTML = `<div class="chattext" style="width:320px">
        <div class="x-risu-portrait" data-char="chenhai"><div class="x-risu-portrait-fallback">肖像</div></div>
        <div class="x-risu-portrait" data-char="ChenHai 镇海"><div class="x-risu-portrait-fallback">肖像</div></div>
        <div class="x-risu-portrait" data-char="chenhai2"><div class="x-risu-portrait-fallback">肖像</div></div>
        <div class="x-risu-portrait" data-char="lucie"><img class="x-risu-char-img x-risu-char-lucie" src="${own}"></div>
      </div>`;
    },
    {
      css: scoped(
        // The card's own portrait stylesheet, reduced to what decides which picture is visible.
        `.portrait{position:relative;width:100%;height:234px;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center}
        .portrait .char-img{display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center;border-radius:7px;z-index:2}
        .portrait[data-char*="lucie" i] .char-lucie{display:block}
        .portrait-fallback{position:relative;z-index:1}` + appended,
      ),
      own: `data:image/png;base64,${state.images[1].toString("base64")}`,
    },
  );
  const overlay = (target: string) =>
    page.evaluate((selector) => {
      const style = getComputedStyle(
        document.querySelector(selector)!,
        "::after",
      );
      return {
        image: style.backgroundImage,
        position: style.position,
        size: style.backgroundSize,
        repeat: style.backgroundRepeat,
        zIndex: style.zIndex,
      };
    }, target);
  const dataUrl = (image: Buffer) =>
    `url("data:image/png;base64,${image.toString("base64")}")`;
  await expect
    .poll(() => overlay('[data-char="chenhai"]'))
    .toMatchObject({
      image: dataUrl(state.images[0]),
      position: "absolute",
      size: "cover",
      repeat: "no-repeat",
      zIndex: "3",
    });
  await expect
    .poll(() =>
      overlay('[data-char="ChenHai 镇海"]').then((style) => style.image),
    )
    .toBe(dataUrl(state.images[0]));
  await expect
    .poll(() => overlay('[data-char="chenhai2"]').then((style) => style.image))
    .toBe("none");
  await expect
    .poll(() => overlay('[data-char="lucie"]').then((style) => style.image))
    .toBe("none");
  expect(
    await page.evaluate(
      () =>
        getComputedStyle(document.querySelector(".x-risu-char-lucie")!).display,
    ),
  ).toBe("block");
});
