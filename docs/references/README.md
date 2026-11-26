# 服装与构图参考

后续 agent 可使用 [参考检索 skill](../../.agents/skills/witch-paintbox-reference-search/SKILL.md)，通过小批候选搜索与按来源 ID 展开快速读取资料。Skill、查询脚本、两套资料和本组合指南均随项目维护；本机用户技能入口指向仓库版本。

这两套图鉴可以配合使用：先用整套服装确定衣着，再用构图鉴补充镜头、姿势、表情、背景和光影。需要细调鞋袜、袖子、首饰时，也可从构图鉴查单个服饰标签。

| 资料 | 收录内容 | 从哪里开始 |
| --- | --- | --- |
| 更衣人偶 · Sol | 430 套完整服装、430 张例图 | [总目录](kisegaeningyou/README.md) · [中文服装类型](kisegaeningyou/categories.md) · [英文标签](kisegaeningyou/tags.md) |
| 渡鸦的构图鉴 · 渡鸦 | 6633 个条目、6803 张例图，涵盖构图、动作、背景、服饰等 | [总目录](raven-composition/README.md) · [原站分类](raven-composition/categories.md) · [英文标签](raven-composition/tags.md) |

## AI 查阅顺序

1. 读用户目标及现有角色资料，确定需要修改服装，还是仅设计当轮画面。
2. 按更衣人偶中文类型找到整套服装候选，读取对应条目及本地例图，按设定修改颜色、材质和配饰。
3. 到渡鸦分类目录按“视角构图 → 景别/机位”“姿势”“面部表情”“背景”“色彩光影”选需要的少量标签。分类名以当前目录为准。
4. 需要衣着细节时，查渡鸦的鞋子、袜子、上衣、套装、礼服、传统服饰及各部位配饰。避免叠加两套互相覆盖的完整穿搭。
5. 把候选方案整理为“固定外貌 / 服装 / 当轮画面 / 负向约束”，去重并处理冲突。只读命中条目，不一次加载所有分册或原始 JSON。
6. 向用户说明参考的服装编号和构图条目 ID。实际预览及保存继续遵循对应维护技能；保存参考库本身不触发生图或导入。

## 标签分别放在哪里

| 内容 | 建议位置 |
| --- | --- |
| 用户确认的固定发色、瞳色、发型、体型等 | 人物 appearance，保留已有设定 |
| 衣服、鞋袜、首饰及服饰配件 | outfits[].tags |
| 景别、视角、姿势、表情、武器、场景、背景、光影 | 当轮绘图提示词；预览时可放 extra |
| 对应模型与任务确实需要的排除项 | 当轮 negative，合并现有设置，不直接覆盖 |

原始条目可能混有角色名、身体特征、动作或场景，必须逐项判断。构图鉴中的“角色图鉴”“发型”“眼睛”“身份设定”等属于可选参考，不能据此改写当前人物身份或外貌。

## 一个可追溯的组合示例

以更衣人偶 [服装002](kisegaeningyou/galleries/gallery-1.md#kisegaeningyou-0002) 的白色连衣裙、分离袖、手套、长袜和高跟鞋作为服装候选；到渡鸦 [标签索引](raven-composition/tags.md) 查以下条目：

| 用途 | 来源 ID | 来源标签 |
| --- | --- | --- |
| 站立 | raven_composition-1327 | standing |
| 正面直拍 | raven_composition-3998 | straight-on |
| 全身构图 | raven_composition-4029 | full_body |
| 简单背景 | raven_composition-2214 | simple_background |
| 白色背景 | raven_composition-2216 | white_background |

服装字段只保存：

```text
ascot, detached sleeves, frilled sleeves, frills, white dress, white gloves, white thighhighs, high heels
```

这次展示服装的画面可选：

```text
standing, straight-on, full_body, simple_background, white_background
```

上述标签来自两套图鉴，尚未针对当前人物实际出图验证。若作为默认人设立绘，按维护技能补充面向镜头、平视等要求；俯拍、仰拍和倾斜构图留给用户要求的场景图。想展示鞋袜时选全身，想展示表情时再选择上半身或近景，避免同时要求互斥景别。

## 检索与更新

仓库根目录可直接搜索中文、英文、编号：

```bash
rg -n -i 'kimono|yukata' docs/references/kisegaeningyou/galleries
rg -n -i '正面直拍|全身构图|柔光' docs/references/raven-composition/sections
rg -n 'raven_composition-3998' docs/references/raven-composition
```

各图鉴目录内的 sync.mjs 支持联网更新和 `--offline` 校验。作者、来源链接、原始资料版本和图片哈希随快照保存；本页是本仓库编写的组合指南，不是原作者的分类或效果保证。
