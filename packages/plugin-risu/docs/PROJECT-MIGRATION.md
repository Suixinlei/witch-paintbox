# 工程结构与第二步协议

Vite library IIFE 构建，严格 TypeScript，ESLint 约束业务与 UI 分离。step1 独立维护资料；step2 通过只读 LibraryReader 引用资料。

第二步只调用一次 DeepSeek JSON 接口，保留人物身份引用，不让模型输出 appearance。step2/deepseek.ts 负责连接与唯一请求，planning.ts 负责结构/引用校验与本地排版，worker.ts 负责持久化和 ComfyUI 流程。

额外外观整理和自动修正调用已移除。源实例和 6001 不因构建或隔离测试发生更新，部署需另行明确执行。
