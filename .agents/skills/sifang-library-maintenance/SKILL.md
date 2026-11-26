---
name: sifang-library-maintenance
description: Use when maintaining 四方世界 character anchors (人员/角色), their outfits (服装), shared outfits (通用服装), or character portraits (人设图) in the Witch Paintbox local service. Reads and writes the service config packet directly with no service restart, generates NAI preview portraits serially for user confirmation before writing. 维护四方角色/服装/人设图，免重启写入，先出图确认再落数据。
---

# 四方世界角色与服装维护

数据存在独立服务的 `settings.wp` 配置包里（角色锚点 anchors + 通用服装 sharedOutfits，人设图以 base64 内嵌）。
脚本走和管理台服务编辑器相同的 `GET/POST /v1/config` 路径：服务端校验 revision 后原子写文件并热更新内存快照，**无需重启服务**，保存即生效。
所有命令输出单行 JSON；只读需要的字段，不要把整包配置或 base64 读进上下文。

默认在 WSL2 的 `/mnt/d/Projects/witch-paintbox` 运行，使用 Linux 原生 Node；无需切回 Windows shell。脚本：

```
node .agents/skills/sifang-library-maintenance/scripts/paintbox.mjs <命令>
```

令牌自动从 Windows 的 `%LOCALAPPDATA%/WitchPaintbox/service.env`（WSL2 自动解析挂载路径，也可用 `PAINTBOX_ENV_FILE` 指定） 读取，服务默认 `127.0.0.1:4783`。

## 命令

- `list` —— 全部角色与通用服装的紧凑清单（id、名称、别名、服装名、默认服装、是否有图）。先看这个。
- `show <角色名或id>` —— 单个角色完整资料（appearance、negative、各服装 tags）。`show <名> --shared` 看通用服装 tags。
- `portrait <角色名或id> [--file 路径]` —— 把已有角色图导出成文件查看。
- `draw --character <角色> [--outfit <已有服装> | --tags <新服装tags>] [--extra <场景/表情tags>] [--size 832x1216] [--file 路径]`
  —— 用服务配置里的 NAI 画师串/参数出预览图：positive = 画师串 + 角色 appearance + 服装 tags + extra，negative = 全局负面 + 角色负面。
  `--size` 覆盖服务默认画幅，竖版人设图用 `832x1216`；可选 `832x1216 / 1216x832 / 1024x1024 / 768x1344 / 1344x768 / 896x1152 / 1152x896`。
  新角色或完全自定义用 `draw --positive <提示词> [--negative <提示词>] [--label 名]`（raw 模式不含画师串，需要时自己加）。
  返回 `{file, seed, width, height, historyId}`，图片落在临时目录，把 file 给用户看。
- `apply <ops.json>` —— 按操作数组改配置并写回服务。本地先用仓库 `parseArchive` 校验，失败不写入；revision 冲突返回 409，重新 list/show 再改。
- `archive <角色名或id...>` —— 把角色连同服装与人设图归档出库，存入 skill 目录 `archive/anchors-archive.json`，并从服务配置移除（免重启，可 restore）。长期不登场的人物用这个，不要用 `remove-character` 硬删。
- `restore <角色名或id...>` —— 从归档装回服务配置（含人设图），别名与本名冲突会报错。
- `archived` —— 列出当前归档中的角色。

## 工作流

1. `list` 看现状；要改谁就 `show` 谁，拿到现有 appearance 与服装。
2. **人物与服装分离**：appearance 只放固定特征（版权角色名、发色发型、瞳色、肤色、体型、种族等）；服装 tags 只放衣着与配饰，**不含武器**，也**不含背景/场景**。
   武器、表情、动作、场景留给当轮生图（预览时可放进 `--extra`），不要写进 appearance 或服装 tags。新增服装不得包含人物 appearance。
3. 新服装/新角色**先出图确认**：`draw` 生成预览（新服装用 `--tags` 传未保存的 tags），把图片给用户确认。
   人设图（默认立绘）必须**正视图、平视机位**：人物面向镜头站姿，可略微转头，禁止俯视/仰视/侧背/前倾等特殊大角度。
   出图时 positive 加 `front view, facing viewer, eye-level, straight-on angle`，negative 加 `from side, from behind, from above, from below, high angle view, low angle view, foreshortening`。
   定稿人设图复制到 `/mnt/c/Users/joshu/Downloads/<角色名>-人设图.png` 供用户上传，`portraitFile`/`set-portrait` 用该文件。
4. **画图不能并发**：一次只跑一个 `draw`，等它返回再跑下一个。脚本有临时锁，服务生图队列本身也串行（并发会排队），但仍不要并行发起。
5. 用户确认后写 ops.json 并 `apply`。新角色人设图：先 `draw` 确认，再在 `add-character` 里用 `portraitFile` 指向该图，或单独 `set-portrait`。
6. `apply` 返回 `{ok, revision, changed}` 即成功，免重启。向用户报告改了什么。

## ops.json 操作

数组，每项一个操作。角色/服装均可用名称或 id 定位；新 id 省略时自动生成。

```json
[
  {"op":"add-outfit","character":"笑斌","outfit":{"name":"和风装束","tags":"..."},"select":false},
  {"op":"set-default-outfit","character":"笑斌","outfit":"和风装束"},
  {"op":"remove-outfit","character":"笑斌","outfit":"旧服装"},
  {"op":"add-shared-outfit","outfit":{"name":"通用校服","tags":"..."}},
  {"op":"remove-shared-outfit","outfit":"通用校服"},
  {"op":"add-character","character":{"name":"新角色","aliases":["别名"],"appearance":"...","negative":"","outfits":[{"name":"日常装","tags":"..."}],"selectedOutfitId":"日常装","portraitFile":"/mnt/c/path/portrait.png"}},
  {"op":"update-character","character":"笑斌","fields":{"appearance":"...","negative":"...","aliases":["..."]}},
  {"op":"set-portrait","character":"笑斌","file":"/mnt/c/path/portrait.png"},
  {"op":"clear-portrait","character":"笑斌"},
  {"op":"remove-character","character":"旧角色"}
]
```

`select:true` 把新服装设为默认；`set-default-outfit` 省略 outfit 表示只用固定外貌。`update-character.fields` 只写要改的键。

## 硬性约束（服务端会校验，违反则 apply 失败）

- 角色名与别名必须含中文汉字；名 ≤80 字符，别名 ≤20 个且全局唯一、不能与本名相同。
- 同一角色内服装不能同名；服装名不能叫「无服装」。appearance/服装 tags ≤32768 字符。
- 通用服装名不能含逗号、换行、斜杠、英文括号、反斜杠或 `::`。
- 角色图仅 PNG/JPEG/WebP，≤10 MB。
- 不要顺手改动用户未要求的 appearance 固定特征或其他角色。