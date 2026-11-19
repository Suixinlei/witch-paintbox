---
name: witch-paintbox-operations
description: Deploy the local Windows Witch Paintbox server, publish the 四方世界 plugin to GitHub, or apply the local Risu drawing plugin. Use for release, restart, verification, and installation requests for this monorepo.
---

# 魔女画匣三端运维

以下命令从仓库根目录运行。按用户本次点名的端执行。用户同时要求部署服务和发布四方时，先准备发布提交，在同一份待发布代码上部署和验证服务，再推 GitHub。

## Server

用户授权更新并重启时，在一次 PowerShell tool call 执行以下命令。若 shell 返回进程会话，等待该会话并读取最终状态。

```powershell
& ./skills/witch-paintbox-operations/scripts/update-server.ps1 -Apply
```

省略 `-Apply` 时只检查运行状态。脚本构建并跑服务测试，在独立目录安装运行依赖，用临时端口和空数据预检。建议在无人发起新任务的时段操作。脚本看到队列空闲后切换并重启 Windows 计划任务 `Witch Paintbox Local Service`，沿用 `%LOCALAPPDATA%/WitchPaintbox/service.env` 和原数据目录。验收包括端口 4783 的新进程、管理页、权限、配置版本、历史图片和 Risu 偏好。仅在报告 `updated` 时确认部署成功。若失败，按脚本结果区分旧服务仍在、已回退或回退失败。验收使用现有记录，无需真实出图。

## 四方世界

1. 核对 `origin` 为 `Suixinlei/witch-paintbox`。从远端取回 `sifang-standalone-service`，以它作为发布基线，保留远端提交。检查根目录 `manifest.json`、`packages/plugin-sifang/manifest.json` 和包版本一致，版本高于上次已发布的清单。
2. 运行 `pnpm --filter @witch-paintbox/plugin-sifang build`、`pnpm test:sifang` 和 `pnpm test:sifang:browser`。提交发布范围内的源码、根清单及 `packages/plugin-sifang/dist/`。确保根清单的 `js` 指向已提交的产物。
3. 用户授权发布后，执行 `git push origin HEAD:refs/heads/sifang-standalone-service`。只做快进。用 `git ls-remote origin refs/heads/sifang-standalone-service` 核对 SHA，再回报版本、分支和提交。用户自行在四方点「检查更新」并安装。

## Risu

目标是 `D:/Projects/risu` 的 `127.0.0.1:6001`，插件标识为 `global-comfy-image`。先跑 `pnpm --filter @witch-paintbox/plugin-risu check`、`pnpm --filter @witch-paintbox/plugin-risu lint` 和 `pnpm test:risu`。从仓库根目录用现有更新脚本预览，`already-current` 表示已完成，无须关页。

```powershell
& ./packages/plugin-risu/skills/risu-plugin-update/scripts/update-local.ps1 -RisuRoot 'D:/Projects/risu'
```

如果需要更新，等用户确认已关闭 6001 上的 Risu 页面，包括其他标签页和设备。如果用户说的是停止 6001 服务，核对端口已停止监听。端口状态无法代替关页确认。收到确认后由 Codex 执行：

```powershell
& ./packages/plugin-risu/skills/risu-plugin-update/scripts/update-local.ps1 -RisuRoot 'D:/Projects/risu' -Apply -PageClosed
```

脚本会备份并校验，只替换目标插件代码和版本。报告 `updated` 或 `already-current`，有备份时附上路径，由用户重新打开 Risu。若脚本拒绝写入，读取仓库内的 `packages/plugin-risu/skills/risu-plugin-update/SKILL.md`。复制分发文件和写入已安装插件是两个操作。
