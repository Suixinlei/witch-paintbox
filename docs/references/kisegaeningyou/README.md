# 更衣人偶：服装参考库

收录 [法典图鉴 · 更衣人偶](https://novelai.quicktagcloud.com/?c=kisegaeningyou) 的全部 **430 套服装**，含原始英文提示词、430 张本地 JPG 例图、原图链接及可检索索引。作者 **Sol**，源资料版本 **2026.9.6**，例图模型 **NoobXL V**。采集日期（北京时间）：2026-11-26。

## 快速查找

- [服装与构图组合指南](../README.md) · [渡鸦构图参考库](../raven-composition/README.md)：搭配镜头、姿势、表情、背景与光影，也可查单个服饰配件标签。
- [按中文服装类型查找](categories.md)：礼服、日常、制服、和风、泳装、内衣、奇幻、袜类、鞋靴、配件等；按标签自动分组，可交叉出现。
- [完整英文标签索引](tags.md)：按单个标签反查所有服装编号。
- [完整结构化资料](catalog.json)：来源 JSON，保留全部条目、原始 tags、images、rawTag 和元数据，供脚本精确筛选。
- [来源与校验记录](provenance.json)：数据版本、内容寻址 URL、JSON 和全部本地图片的 SHA-256。

| 画廊 | 套数 | 编号范围 |
| --- | ---: | --- |
| [画廊1](galleries/gallery-1.md) | 102 | 服装001—服装102 |
| [画廊2](galleries/gallery-2.md) | 105 | 服装103—服装207 |
| [画廊3](galleries/gallery-3.md) | 77 | 服装208—服装284 |
| [画廊4](galleries/gallery-4.md) | 90 | 服装285—服装374 |
| [画廊5](galleries/gallery-5.md) | 56 | 服装375—服装430 |

## AI 维护服装时如何使用

1. 先读本页，根据用户要求在 categories.md 或 tags.md 找候选，再只读对应画廊段落和例图；不要一次读完整 JSON 或所有画廊。
2. 命令行可用 `rg -n -i 'kimono|yukata' docs/references/kisegaeningyou/galleries` 搜索；用 `rg -n -i 'white dress' docs/references/kisegaeningyou/tags.md` 找精确标签。
3. 来源 tags 是参考，不直接作为角色库成品。按人物设定选衣服并改颜色、材质、配饰；保留服装主体和层次，去掉与需求冲突的项目。固定外貌放 appearance，衣服和配饰放 outfits[].tags，武器、动作、表情、背景留给当轮提示词。
4. 原文可能含身体特征、角色 cosplay、暴露程度、转义或非标准拼写。角色 cosplay 标签可能带入外貌特征，需要按目标角色判断取舍；不能把原文全部当成纯服装标签。分类仅为检索辅助，来源 rating 也不代表本仓库逐图审定。
5. 例图来自 NoobXL V，不保证 NovelAI 完全复现。实际维护、预览和写入流程继续遵循对应的 Risu／四方维护技能。回报参考方案时注明服装编号，方便追溯。

## 来源与文件范围

- [作者网站 · 更衣人偶](https://hayde0096.github.io/kisegae/)
- [图文素材仓库](https://github.com/hayde0096/Kisegaeningyou)
- [网站程序仓库](https://github.com/hayde0096/kisegae)

图片和提示词保留来源署名，仅作本项目维护参考；本仓库不对上游素材另行授予许可。JPG 例图已完整本地保存，可离线查看；较大的原始 PNG 保留在线链接，未重复下载。此目录是独立参考快照，不会自动导入或覆盖服务中的角色和服装。

## 更新与校验

在仓库根目录运行（需要 Node.js 22+；不依赖额外包）：

```bash
node docs/references/kisegaeningyou/sync.mjs
node docs/references/kisegaeningyou/sync.mjs --offline
```

第一条读取网站当前发布清单，校验 JSON 哈希，下载全部 JPG，更新快照及索引；下载未全部成功时以失败退出，请重新运行完成更新。第二条不联网，核对本地 JSON、全部图片哈希、条目数、画廊数，并重建索引。更新前若有人工笔记，另存文件；自动生成的 Markdown 会被重建。
