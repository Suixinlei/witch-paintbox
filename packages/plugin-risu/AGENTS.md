# 插件开发约定

Risu 画图插件源码位于魔女画匣工作区的 `packages/plugin-risu`。Risu 仓库的 `plugins/global-comfy-image/` 接收构建分发文件。

本地已安装插件的备份和更新使用 `skills/risu-plugin-update/SKILL.md`，默认不使用 computer use。仅构建和分发可直接执行；写入真实存档前请用户关闭 Risu 页面，确认后使用配套脚本。用户已确认关闭时不重复询问。用户明确要求安装更新时允许脚本修改目标插件代码；不要以验证重构为由修改真实存档。

- 使用 TypeScript 真正的 ES 模块，开启 strict；禁止 any、ts-nocheck 和共享闭包式源码拼接。
- 使用 Vite library 构建，配置在 vite.config.ts；不要另写打包器。
- step1 负责资料抽取、审阅和保存；step2 只依赖 domain 的 LibraryReader，不得导入 step1 或获取资料写入方法。
- UI 页面、DOM 组件、表单和 CSS 位于 ui/；业务代码不能导入 UI 或访问 DOM，UI 通过类型化服务调用操作。
- 修改后运行 pnpm check、pnpm lint、pnpm test:e2e。只维护 Playwright E2E，不添加单元测试或源码切片测试。
- pnpm deploy 在检查通过后复制 Vite 产物，不自动修改存档内已安装的插件。
- 保留插件身份和存储协议，涉及迁移需单独设计。
- 不擅自添加硬编码的内容关键词黑名单，也不将内容限制混入 JSON、坐标或资料 ID 等技术校验；如实显示模型服务的返回结果。
- 不修改真实 save、模型配置、密钥或正在执行的任务来验证重构。

- 第二步在助手回复结束后一次请求选景和编写 NovelAI 标签，按插图分别排队。按场景正文判断入画人物与衣着，固定外貌按资料 ID 在本地展开。重画只提交所选图片的提示词，挂载时按原文版本校验。
