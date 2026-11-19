# 全局 ComfyUI 生图：构建分发目录

2.2.1 默认使用[主模型绘图模式](MAIN-MODEL-GENERATION.md)：动态注入世界书规则，通过 ID 引用统一姓名，根据实际姿势选择第一或第三人称，ID 比较忽略大小写；结合本轮状态栏选择画内人物，一张图支持多人，不额外调用第二步模型。保留旧 DeepSeek 模式开关。

要用本机 LM Studio 写 Tag，在第二步设置中将「写 Tag 模型」切换为「LM Studio（本地）」并保存。插件使用本机 1234 端口和配置中的模型 ID，每次返回一幅图的构图 JSON。可先点「预览本轮构图 JSON（不生图）」检查结果。

本目录由独立 Git 工程 risu-comfy-image-plugin 的 pnpm deploy 生成。请在独立工程的 TypeScript 源码中开发，不要直接修改 plugin.js。

构建使用 Vite，测试仅使用 Playwright E2E。运行 pnpm deploy 会依次执行 ESLint、严格类型检查、Vite 构建和浏览器测试，成功后复制产物并校验 SHA-256。

plugin.js 是可导入 Risu 的单文件插件，plugin.js.map 用于调试，build.json 记录产物指纹。已导入存档的插件需在插件管理中重新导入。部署不会修改真实配置、资料、图片和任务。

本地 Node 自托管实例可改用 [risu-plugin-update](skills/risu-plugin-update/SKILL.md)：运行 `./skills/risu-plugin-update/scripts/update-local.ps1` 只读预览；关闭本地 Risu 页面后加 `-Apply -PageClosed`，一条命令完成备份、更新和校验。不默认使用 computer use。

第一步资料抽取、第二步生图和 UI 在源码工程中独立分层，具体结构与当前命令见该工程 README.md；本目录其他文档为功能协议或历史记录。
