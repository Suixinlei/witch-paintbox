import { expect, test, type Page } from "@playwright/test";

const service = "http://127.0.0.1:4783";
const fakeToken = "fixture-consumer-token-0000";
const card = "char-A";
// The card's own gate: its panels only exist on the newest message.
const gate =
  "{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}}}}}}}";
const status = (id: string) =>
  `<statusData>c|varId:${id}|equipment:校服|mode:普通|status:[平静]|affection:20|log:无变动</statusData>`;
const reply = `她推门走进图书室，把借阅册放在桌上。\n\n${status("chenhai")}\n${status("megumi")}`;
const digest = (n: number) => n.toString(16).padStart(32, "0");
const link = (n: number, suffix = ".webp", id = card) =>
  `/v1/risu/portrait/${id}/${digest(n)}${suffix}`;
const url = (n: number, suffix?: string) =>
  `url("${service}${link(n, suffix)}")`;

async function solid(page: Page, color: string) {
  await page.setContent(
    `<body style="margin:0;width:4px;height:6px;background:${color}"></body>`,
  );
  return page.screenshot({ clip: { x: 0, y: 0, width: 4, height: 6 } });
}

interface Entry {
  id: string;
  name: string;
  aliases: string[];
  picture: number;
  original?: string;
  /** Replaces the picture address, for simulating a hostile service. */
  thumb?: string;
}

async function mockLibrary(page: Page) {
  // Three flat colours tell apart the two panel-sized copies and the original.
  const images = {
    copy: await solid(page, "#aa5c72"),
    other: await solid(page, "#5c72aa"),
    original: await solid(page, "#72aa5c"),
  };
  const library: { revision: string; portraits: Entry[] } = {
    revision: "library-1",
    portraits: [
      {
        id: "chenhai",
        name: "镇海（Chen Hai）",
        aliases: ["ZhenHai"],
        picture: 1,
        original: "png",
      },
      { id: "megumi", name: "加藤惠（Katou Megumi）", aliases: [], picture: 2 },
    ],
  };
  const state = {
    images,
    fail: false,
    // `hold` leaves the request unanswered, like a service that hangs.
    hold: false,
    requests: [] as { cardId: string; revision?: string; links?: boolean }[],
    pictures: [] as string[],
  };
  // Pictures are fetched by the page straight from the service; keep them away from the real one.
  await page.route(`${service}/v1/risu/portrait/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    state.pictures.push(path);
    const picture = path.includes(digest(2)) ? images.other : images.copy;
    return route.fulfill({
      contentType: "image/png",
      body: path.includes(".full.") ? images.original : picture,
    });
  });
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
        links?: boolean;
      };
      state.requests.push(body);
      if (state.hold) return new Promise<void>(() => {});
      if (state.fail) return route.abort("connectionfailed");
      if (body.revision === library.revision)
        return route.fulfill({
          json: { revision: library.revision, unchanged: true },
        });
      return route.fulfill({
        json: {
          revision: library.revision,
          portraits: library.portraits.map(
            ({ picture, original, thumb, ...portrait }) => ({
              ...portrait,
              width: 4,
              height: 6,
              thumb: thumb ?? link(picture, ".webp", body.cardId),
              ...(original
                ? { full: link(picture, `.full.${original}`, body.cardId) }
                : {}),
            }),
          ),
        },
      });
    }
    throw Error("Unexpected paintbox endpoint " + endpoint);
  });
  return { state, library };
}

async function openPlugin(page: Page) {
  await page.goto("/e2e/fixture/");
  await page.getByRole("heading", { name: "魔女画匣", exact: true }).waitFor();
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
/** The style of a handler result, i.e. what the newest message keeps once the card's gate evaluates true. */
const styleOf = (styled: string) =>
  styled.slice(
    styled.indexOf("<style>\n") + 8,
    styled.lastIndexOf("\n</style>{{/}}"),
  );

test("every message carries one small block that names each character by link", async ({
  page,
}) => {
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  for (const text of [
    reply,
    "她走进图书室。",
    "<statusData>u|time:17:35|date:4月22日 周二</statusData>",
  ]) {
    const styled = (await display(page, text)) ?? "";
    expect(styled.startsWith(`${text}\n\n${gate}<style>\n`)).toBe(true);
    expect(styled.endsWith("\n</style>{{/}}")).toBe(true);
    const css = styleOf(styled);
    expect(css).toContain(
      `[data-char="chenhai" i],[data-char="ZhenHai" i]{--wp-portrait:${url(1)};--wp-portrait-full:${url(1, ".full.png")};--wp-ratio:0.666667}`,
    );
    expect(css).toContain(
      `[data-char="megumi" i]{--wp-portrait:${url(2)};--wp-ratio:0.666667}`,
    );
    // Pictures are no longer inlined: the page loads them from the service itself.
    expect(styled.length).toBeLessThan(text.length + 3000);
    expect(styled).not.toContain("data:image");
  }
  expect(await display(page, "")).toBeUndefined();
  expect(state.requests).toEqual([{ cardId: card, links: true }]);
});

test("a character is named by id, alias or short name, ids first, and only in the shape of a status varId", async ({
  page,
}) => {
  const { library } = await mockLibrary(page);
  library.portraits = [
    { id: "soda", name: "索达", aliases: [], picture: 1 },
    // A name that equals another character's id must not take that id over.
    { id: "maid", name: "soda", aliases: ["Soda"], picture: 2 },
    {
      id: "chenhai",
      name: "镇海（Chen Hai）",
      aliases: ["ZhenHai", "Chen Hai"],
      picture: 3,
      original: "jpeg",
    },
    {
      id: "kanashi",
      name: "Kanashi_Hospithera（香奈诗）",
      aliases: [],
      picture: 4,
    },
    // Neither the id nor the alias has the shape of a status varId, so no selector can name this character.
    { id: "触手君", name: "触手君", aliases: ["T.T. Star"], picture: 5 },
  ];
  await openPlugin(page);
  await connect(page);
  const css = styleOf((await display(page, "你好")) ?? "");
  expect(css.split("\n").slice(0, 4)).toEqual([
    `[data-char="soda" i]{--wp-portrait:${url(1)};--wp-ratio:0.666667}`,
    `[data-char="maid" i]{--wp-portrait:${url(2)};--wp-ratio:0.666667}`,
    `[data-char="chenhai" i],[data-char="ZhenHai" i]{--wp-portrait:${url(3)};--wp-portrait-full:${url(3, ".full.jpeg")};--wp-ratio:0.666667}`,
    `[data-char="kanashi" i],[data-char="Kanashi_Hospithera" i]{--wp-portrait:${url(4)};--wp-ratio:0.666667}`,
  ]);
  expect(css).not.toContain("触手");
  expect(css).not.toContain(url(5));
});

test("a picture address that is not exactly the service's shape never reaches the style", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.resume();
  const { library, state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  for (const thumb of [
    'http://evil.test/x",body{display:none}',
    "/v1/admin/risu",
    `${link(1).slice(0, -1)}g`,
    link(1).replace(card, `other/../${card}`),
    `${link(1)}?x=1`,
  ]) {
    library.portraits = [
      { id: "chenhai", name: "镇海", aliases: [], picture: 1, thumb },
    ];
    const before = state.requests.length;
    expect(await display(page, "你好")).toBeUndefined();
    expect(state.requests).toHaveLength(before + 1);
    // A rejected answer is not retried for a while.
    expect(await display(page, "你好")).toBeUndefined();
    expect(state.requests).toHaveLength(before + 1);
    await page.clock.fastForward(31_000);
  }
});

test("the library is revalidated by revision and the block survives a failing service", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.resume();
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  const first = await display(page, reply);
  expect(first).toContain(`--wp-portrait:${url(1)}`);
  await display(page, reply);
  expect(state.requests).toEqual([{ cardId: card, links: true }]);
  await page.clock.fastForward(11_000);
  expect(await display(page, reply)).toBe(first);
  expect(state.requests).toEqual([
    { cardId: card, links: true },
    { cardId: card, links: true, revision: "library-1" },
  ]);
  state.fail = true;
  await page.clock.fastForward(11_000);
  expect(await display(page, reply)).toBe(first);
  await display(page, reply);
  expect(state.requests).toHaveLength(3);
  state.fail = false;
  await page.clock.fastForward(31_000);
  expect(await display(page, reply)).toBe(first);
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
  await page.clock.fastForward(11_000);
  const other = (await display(page, reply)) ?? "";
  expect(other).toContain(`url("${service}${link(1, ".webp", "char-B")}")`);
  expect(state.requests).toEqual([
    { cardId: card, links: true },
    { cardId: "char-B", links: true },
  ]);
});

test("a service that stops answering costs one short wait, not one per message", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.resume();
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  const first = await display(page, reply);
  state.hold = true;
  await page.clock.fastForward(11_000);
  const waiting = display(page, reply);
  await page.clock.runFor(2600);
  expect(await waiting).toBe(first);
  expect(await display(page, reply)).toBe(first);
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
  expect(await display(page, reply)).toContain(`--wp-portrait:${url(1)}`);
  await page.evaluate(() => window.harness.unload());
  expect(await display(page, reply)).toBeUndefined();
  expect(state.requests).toEqual([{ cardId: card, links: true }]);
});

// The card's own stylesheet, reduced to what decides where a picture lands.
const cardStyle = `
.portrait{position:relative;width:100%;height:120px;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f5eef8}
.portrait-fallback{position:relative;z-index:1}
.rp-root *{box-sizing:border-box}
.rp-root .rp-portrait{width:72px;height:72px;border-radius:50%;border:1px solid rgba(201,162,39,.26);background-color:#181309;background-size:cover;background-position:center top;background-repeat:no-repeat;overflow:hidden}
.rp-root .rp-detail-in{display:flex;flex-direction:row;align-items:flex-start}
.rp-root .rp-standing{position:relative;flex:0 0 34%;max-width:300px;min-width:130px;height:auto;border:1px solid rgba(201,162,39,.55);border-radius:0;overflow:hidden;background-image:linear-gradient(150deg,#1a160e,#0e0c07);cursor:zoom-in}
.rp-root .rp-standing img{display:block;width:100%;height:auto;margin-top:0}
.rp-root .rp-standing::after{content:'';position:absolute;top:4px;left:4px;right:4px;bottom:4px;border:1px solid rgba(201,162,39,.45);pointer-events:none}
.rp-root .rp-zoom-layer{display:none;position:fixed;inset:0;z-index:2100;background:rgba(5,3,1,.93);cursor:zoom-out}
.rp-root .rp-zoom-toggle:checked ~ .rp-zoom-layer{display:flex;align-items:center;justify-content:center}
`;

/** On the newest message Risu scopes every message style to the chat text and prefixes its classes. */
function scoped(css: string) {
  return css
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
}

/** The colour of one screenshot pixel; the flat test pictures turn this into a check that the picture really painted. */
async function pixel(page: Page, x: number, y: number) {
  const png = await page.screenshot({
    clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 },
  });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, png.toString("base64"));
}

const near = (color: number[], expected: number[]) =>
  color.every((channel, index) => Math.abs(channel - expected[index]) <= 6);
const chenhai = [170, 92, 114];
const megumi = [92, 114, 170];
const original = [114, 170, 92];

test("every kind of portrait slot paints its picture, and a character without one keeps the card's own", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  const { state } = await mockLibrary(page);
  await openPlugin(page);
  await connect(page);
  const css = scoped(cardStyle + styleOf((await display(page, reply)) ?? ""));
  await page.evaluate(
    ({ css }) => {
      document.head.innerHTML = `<style>body{margin:0}${css}</style>`;
      // Scoped card rules read `.chattext .x-risu-rp-root`, so the root sits inside the chat text, as in Risu.
      document.body.innerHTML = `<div class="chattext" style="width:320px">
          <div class="x-risu-portrait" data-char="chenhai" id="panel"><div class="x-risu-portrait-fallback">肖像</div></div>
          <div class="x-risu-portrait" data-char="nobody" id="bare"><div class="x-risu-portrait-fallback">肖像</div></div>
        </div>
        <div class="chattext"><div class="x-risu-rp-root"><div class="x-risu-rp-detail-in">
          <div class="x-risu-rp-portrait" data-char="megumi" data-wp="face" id="face"></div>
          <input type="checkbox" id="zoom-toggle" class="x-risu-rp-zoom-toggle">
          <label class="x-risu-rp-zoom-layer" data-char="chenhai" data-wp="zoom" for="zoom-toggle" id="zoom"></label>
          <label class="x-risu-rp-standing" data-char="chenhai" data-wp="standing" for="zoom-toggle" id="standing"><img src="" alt=""></label>
        </div></div></div>`;
    },
    { css },
  );
  const box = async (selector: string) =>
    (await page.locator(selector).boundingBox())!;
  const point = async (selector: string, dx: number, dy: number) => {
    const rect = await box(selector);
    return pixel(page, rect.x + dx, rect.y + dy);
  };
  const overlay = (selector: string) =>
    page.evaluate(
      (target) =>
        getComputedStyle(document.querySelector(target)!, "::before")
          .backgroundImage,
      selector,
    );
  expect(await overlay("#panel")).toBe(url(1));
  // Without a picture in the library nothing is painted and the card's placeholder stays visible.
  expect(await overlay("#bare")).toBe("none");
  expect(await overlay("#face")).toBe(url(2));
  const fetched = () =>
    state.pictures.map((path) => [
      path.includes(digest(1)),
      path.includes(digest(2)),
      path.includes(".full."),
    ]);
  await expect.poll(() => fetched()).toContainEqual([true, false, false]);
  await expect.poll(() => fetched()).toContainEqual([false, true, false]);
  // The status panel's portrait: cropped from the top over the card's placeholder.
  const panel = await box("#panel");
  expect(near(await pixel(page, panel.x + 40, panel.y + 60), chenhai)).toBe(
    true,
  );
  // The placeholder of a character without a picture, sampled above its text.
  expect(near(await point("#bare", 40, 12), [245, 238, 248])).toBe(true);
  // A round portrait.
  expect(near(await point("#face", 36, 36), megumi)).toBe(true);
  // A standing picture: the empty <img> borrows the picture's ratio, so the slot is as tall as the picture.
  const standing = await box("#standing");
  expect(
    Math.abs(standing.height - 2 - (standing.width - 2) * 1.5),
  ).toBeLessThan(2);
  expect(near(await point("#standing", 100, 150), chenhai)).toBe(true);
  // The original is only fetched when the reader actually zooms in.
  expect(state.pictures.some((path) => path.includes(".full."))).toBe(false);
  await page.locator("#standing").click();
  await expect(page.locator("#zoom")).toBeVisible();
  await expect
    .poll(() =>
      state.pictures.some((path) => path.endsWith(`${digest(1)}.full.png`)),
    )
    .toBe(true);
  const zoom = await overlay("#zoom");
  // The picture is the top layer, so the gold frame shows only as its 1px ring.
  expect(zoom.startsWith(url(1, ".full.png"))).toBe(true);
  expect(
    zoom.endsWith(
      ", linear-gradient(rgba(201, 162, 39, 0.55), rgba(201, 162, 39, 0.55))",
    ),
  ).toBe(true);
  // Centred in the viewport and as tall as 92 of its 800 pixels.
  expect(near(await pixel(page, 500, 400), original)).toBe(true);
  expect(near(await pixel(page, 500, 397), original)).toBe(true);
  // The frame is the one row above the picture, gold over the backdrop.
  expect(near(await pixel(page, 500, 31), [120, 98, 30])).toBe(true);
  // Above it there is only the backdrop.
  expect(near(await pixel(page, 500, 20), original)).toBe(false);
  expect(near(await pixel(page, 60, 400), original)).toBe(false);
});
