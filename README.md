# 魔女画匣

四方世界和 Risu 的画图插件与独立服务在同一个 pnpm workspace 中维护。

| 包 | 职责 |
| --- | --- |
| [`packages/server`](packages/server) | 插图规划、NovelAI 绘图队列、配置管理和图片历史。四方与 Risu 共用服务。 |
| [`packages/plugin-sifang`](packages/plugin-sifang/README.md) | 四方世界和 SillyTavern 插件。服务端复用本包的画图模块。 |
| [`packages/plugin-risu`](packages/plugin-risu/README.md) | Risu API 3.0 插件，负责读取回合、提交配图任务并挂载图片。 |

## 构建与测试

默认在 WSL2 的 `/mnt/d/Projects/witch-paintbox` 使用 Linux 原生 Node.js 22.12 或更新版本和 pnpm 11.25.0。首次准备环境、跨系统依赖隔离和 Windows 运维入口见 [WSL2 开发维护指南](docs/DEVELOPMENT-WSL2.md)。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @witch-paintbox/plugin-risu exec playwright install chromium
pnpm test
```

`pnpm test` 运行四方插件、服务端、两者的浏览器联调以及 Risu 插件的浏览器测试。单独运行某组时可用 `pnpm test:sifang`、`pnpm test:service`、`pnpm test:sifang:browser` 或 `pnpm test:risu`。

## 启动服务

本机现有实例仍由 Windows 计划任务承载，开发、测试和日常维护从 WSL2 执行；已有实例按运维技能检查或升级，不再另启同端口的 WSL 服务。下面的启动命令用于新建实例。

在运行服务的机器上设置现有的 `PAINTBOX_TOKEN`。Risu 接入时另设 `PAINTBOX_RISU_TOKEN`。首次部署可用 `node -p "require('node:crypto').randomBytes(32).toString('hex')"` 分别生成令牌。构建后从仓库根目录运行 `pnpm service`，默认地址为 `http://127.0.0.1:4783`。

默认数据目录仍为仓库根目录的 `paintbox-data/`。从其他 checkout 迁移服务时，用 `PAINTBOX_DATA_DIR` 指向原数据目录。更多设置见[独立服务说明](packages/plugin-sifang/README.md#四方世界独立服务)。

## 更新插件

- **四方世界**：开发源码留在 `main`；`sifang-standalone-service` 仅发布运行包。运行 `pnpm --filter @witch-paintbox/plugin-sifang build:release` 构建 5 文件清单，再运行 `node packages/plugin-sifang/scripts/prepare-release.mjs` 准备快进发布提交。不要把开发目录直接推入发布分支；四方会下载并预载仓库中符合规则的所有文件。
- **Risu** 构建产物位于 `packages/plugin-risu/dist/plugin.js`。运行 `pnpm --filter @witch-paintbox/plugin-risu deploy` 可复制到与本仓库同级的 Risu 工作目录。更新本地已安装插件可使用 [Risu 更新脚本](packages/plugin-risu/skills/risu-plugin-update/SKILL.md)。

Windows 本机的服务部署、四方发布和 Risu 应用流程见[项目级三端运维 Skill](.agents/skills/witch-paintbox-operations/SKILL.md)。

## 参考资料

维护人物服装时，参阅 [更衣人偶服装参考库](docs/references/kisegaeningyou/README.md)：完整收录 430 套服装的提示词和本地例图，提供中文类型目录与英文标签索引。其他资料见 [docs 目录](docs/README.md)。

搭配镜头、姿势、表情、背景与光影时，参阅 [渡鸦构图参考库](docs/references/raven-composition/README.md) 和 [服装与构图组合指南](docs/references/README.md)。
