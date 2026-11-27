# 魔女画匣：Risu 插件构建分发目录

当前是 2.6.0。插件只连接魔女画匣独立服务：回复完成后自动规划配图、依次生图并挂回原文，由服务管理台的自动配图开关控制；Risu 状态面板的肖像位取用画匣人设图，由同一页面的「状态面板肖像取用画匣人设图」开关控制，见[状态面板人设图](STATUS-PORTRAITS.md)。角色卡、服装、模型、画师、Prompt 和图片历史都在服务管理台，插件不提供配置编辑器、图片历史或管理员令牌输入。内部 ID 保持 `global-comfy-image`，已有连接、任务和图片继续读取。

本目录由 witch-paintbox 工作区的 `packages/plugin-risu` 构建分发。请修改该目录的 TypeScript 源码，不要直接修改 plugin.js。

构建使用 Vite，测试仅使用 Playwright E2E。运行 `pnpm deploy` 会依次执行 ESLint、严格类型检查、Vite 构建和浏览器测试，成功后复制产物并校验 SHA-256。源码 `docs/` 里的文档平铺在本目录并按源码镜像，源码里删掉的文档也会从这里消失；`README.md` 由源码的 `distribution.md` 生成。

plugin.js 是可导入 Risu 的单文件插件，plugin.js.map 用于调试，build.json 记录产物指纹。已导入存档的插件需在插件管理中重新导入。部署不会修改真实配置、资料、图片和任务。

本地 Node 自托管实例可改用 [risu-plugin-update](skills/risu-plugin-update/SKILL.md)：运行 `node --experimental-strip-types ./skills/risu-plugin-update/scripts/update-local.ts` 只读预览；关闭本地 Risu 页面后加 `--apply --page-closed`，一条命令完成备份、更新和校验。不默认使用 computer use。
