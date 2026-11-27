---
name: witch-paintbox-portrait
description: 出人设图、画立绘的唯一入口——给魔女画匣 Risu 单卡里的人物调用插件服务生图。只要用户提到给某个角色/人物「出图」「画图」「画一张」「生图」「重画」「出人设图」「立绘」「裸体图」「下体图」「换身衣服看看效果」，就用这个技能，哪怕同时在做加人、改锚点、改服装；不要自己写临时脚本，也不要用 paintbox.mjs draw 手拼提示词。出图种类固定为裸体全身正视图和侧视图、下体图（男性不用）、服装人设图（可存回画匣）；流程是先改 prompt（锚点，改资料交给 risu-library-maintenance）再直接出图，出过的图留在 .local/portraits 不重复出。剧情里的自动配图不归这里。
---

# Risu 人物人设图

技能目录 `/mnt/d/Projects/witch-paintbox/.agents/skills/witch-paintbox-portrait`。

## 流程

1. 先改 prompt：用 `risu-library-maintenance` 的 `library.mjs show <chaId>` 看人物当前的 `appearance`、`negative`、服装，用户要改外形或负面词就用那个技能改好。
2. 然后直接出图，不用再要一轮确认（用户 2026-11-27 明确要求「先改 prompt，然后直接调用插件服务出图」）；出完把张数、文件路径和 seed 报给用户。

```bash
cd /mnt/d/Projects/witch-paintbox
node .agents/skills/witch-paintbox-portrait/scripts/portrait.mjs <chaId> <人物id|别名|名> nude      # 裸体全身：正视图 + 侧视图
node .agents/skills/witch-paintbox-portrait/scripts/portrait.mjs <chaId> <人物> front              # 只要正面
node .agents/skills/witch-paintbox-portrait/scripts/portrait.mjs <chaId> <人物> side               # 只要侧面
node .agents/skills/witch-paintbox-portrait/scripts/portrait.mjs <chaId> <人物> genitals           # 下体图，仅成年女性
node .agents/skills/witch-paintbox-portrait/scripts/portrait.mjs <chaId> <人物> outfit --save     # 服装人设图并存回画匣
```

不写 `cardId` 时默认「学园重生」；人物可以写 id、别名或中文名。`outfit` 默认用人物的默认服装，`--outfit <服装id或名>` 可指定；加 `--save` 才存回画匣的人设图。加 `--preview` 只看提示词不出图。

## 不重复出图

出过的图都留在 `.local/portraits/<cardId>/<人物id>/`，文件名是 `<varId>-<作用>-<时间>.png`（例如 `xiaobin-裸体正面-20261127-160124.png`）。varId 就是画匣人物 id，和卡内状态栏的 varId 一致；作用是 裸体正面 / 裸体侧面 / 下体 / 服装-<服装名>；时间是北京时间。同目录的 `index.json` 记着每张对应的锚点、负面词、服装、画师预设和取景串。

脚本每次先查这份记录：同一种图、人物锚点和服装都没变，就直接返回已有那张（输出里 `reused: true`），不再发请求。锚点或服装改过，旧图算过时，会重出一张新的，旧图和旧记录都留着。提示词没改但用户明确要重画时加 `--redraw`。

所以直接照常跑命令即可，不需要先翻目录判断出没出过。

## 标准套图

人物定稿一般是这几张，顺序为裸体 → 下体 → 穿衣：

- **裸体全身**：正视图加侧视图各一张，832×1216。男性角色同样出。
- **下体图**：只给成年女性角色，1024×1024；男性不用。脚本遇到外貌里没有 `1girl` 的人物会拒绝。
- **服装人设图**：穿默认或指定服装的正面全身，832×1216，这张才是存回画匣、显示在状态栏的图。

只重画用户点名的那张（用 `front` / `side` / `genitals` / `outfit`），不要整套重出。

## 组法

脚本照管理台「角色图」功能（`packages/plugin-sifang/src/anchor-config.ts` 的 `generatePortrait`）拼提示词，取景串都固定在脚本里，出图时不要另加词：

- 正面：`solo` + 固定取景串 + 卡绑定预设的 positive + 人物 `appearance` + 服装 tags。
- 侧面：把取景里的正面朝向换成 `from side`、`profile`，并从固定负面串里去掉 `from side`。
- 裸体各张加 `completely nude, nude`，负面加 `underwear, clothes`——不挂服装时模型会自己补内裤，所以要显式压掉。
- 负面：卡绑定预设的 negative + 固定的角度/半身负面串 + 人物 `negative`。

内置功能读的是全局激活的画师串，这里换成卡绑定的，因为用户要的是卡激活的那条。效果不对时改锚点再重出。

脚本一次只发一个请求，遇到别的出图任务在跑会等它结束再发。卡没有绑定画师预设时脚本会停下，让用户先在管理台的 Risu 卡资料里绑定。

## 交给用户看

出完把每张图的路径（Markdown 链接）和 seed 报给用户。NSFW 图不要用 Read 读回来看，由用户自己看并反馈；不要看完自行重画。

## 存回人设图

`outfit --save` 通过 `library.mjs apply` 的 `set-portrait` 存回，带版本校验、备份和复读验证。只有服装图存回：裸体图是给人看体型用的，不进状态栏。
