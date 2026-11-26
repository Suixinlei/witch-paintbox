---
name: witch-paintbox-operations
description: Use when implementing changes to the Witch Paintbox service or its management UI, and for deployment, restart, verification, or plugin release in this repo. Apply and verify service changes on the local Windows instance before handing back. Also covers GitHub releases of 四方世界 and local Risu plugin updates.
---

# 魔女画匣三端运维

默认从 WSL2 的 `/mnt/d/Projects/witch-paintbox` 运行，使用 Linux 原生 Node 和 pnpm。环境准备与依赖隔离见 [WSL2 指南](../../../docs/DEVELOPMENT-WSL2.md)。只有 Windows 计划任务和 Windows 发布目录的操作通过 powershell.exe 桥接；源码安装、构建和测试仍由部署脚本调用 WSL2。

- 改了独立服务、管理台或服务实际加载的共享运行时代码，就在同一轮完成本机部署和验收，包括从 Risu 发起、实际由服务实现的功能。用户明确要求只改代码或暂缓上线时，按该要求执行。
- GitHub 发布四方插件和写入本机 Risu 已安装插件走各自流程。用户同时要求部署服务和发布四方时，先准备发布提交，在同一份待发布代码上部署和验证服务，再推 GitHub。

## Server

本机服务改动完成后，执行以下命令。若 shell 返回进程会话，等待该会话并读取最终状态。

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w .agents/skills/witch-paintbox-operations/scripts/update-server.ps1)" -Apply
```

省略 `-Apply` 时只检查运行状态。脚本构建并跑服务测试，在独立目录安装运行依赖，用临时端口和空数据预检。建议在无人发起新任务的时段操作。脚本看到队列空闲后切换并重启 Windows 计划任务 `Witch Paintbox Local Service`，沿用 `%LOCALAPPDATA%/WitchPaintbox/service.env` 和原数据目录。验收包括端口 4783 的新进程、管理页、权限、配置版本、历史图片和 Risu 偏好。仅在报告 `updated` 时确认部署成功。若失败，按脚本结果区分旧服务仍在、已回退或回退失败。验收使用现有记录，无需真实出图。

## 四方世界

1. 核对 `origin` 为 `Suixinlei/witch-paintbox`。从远端取回 `sifang-standalone-service`，以它作为发布基线，保留远端提交。检查根目录 `manifest.json`、`packages/plugin-sifang/manifest.json` 和包版本一致，版本高于上次已发布的清单。
2. 运行 `pnpm --filter @witch-paintbox/plugin-sifang build`、`pnpm test:sifang` 和 `pnpm test:sifang:browser`。提交发布范围内的源码、根清单及 `packages/plugin-sifang/dist/`。确保根清单的 `js` 指向已提交的产物。
3. 用户授权发布后，执行 `git push origin HEAD:refs/heads/sifang-standalone-service`。只做快进。用 `git ls-remote origin refs/heads/sifang-standalone-service` 核对 SHA，再回报版本、分支和提交。用户自行在四方点「检查更新」并安装。

## Risu

用户指定 IAB 页面用于调试时，可自行操作该调试页，更新前关闭、更新后重开并实机验收，无须每次再询问关页授权。此授权不扩展到用户在 Edge 等其他浏览器使用的页面。

目标是 `/mnt/d/Projects/risu` 的 `127.0.0.1:6001`，插件标识为 `global-comfy-image`。先跑 `pnpm --filter @witch-paintbox/plugin-risu check`、`pnpm --filter @witch-paintbox/plugin-risu lint` 和 `pnpm test:risu`。从仓库根目录用现有更新脚本预览，`already-current` 表示已完成，无须关页。

```bash
node --experimental-strip-types packages/plugin-risu/skills/risu-plugin-update/scripts/update-local.ts --risu-root /mnt/d/Projects/risu
```

需要更新时，先通过可用的浏览器标签页清单只读检查本机 Risu 页面（6001，包含 localhost、回环地址及已知别名），不要默认直接要求用户关页。检查覆盖完整、未发现目标页面，且没有已知其他设备仍在使用的证据时，可继续安装。发现页面仍开着时说明具体页面；没有关闭授权就请用户关闭。检查不可用或覆盖不完整时，说明缺口再请用户确认。用户已明确确认关闭时直接沿用，不重复检查或询问；不因假设还有其他设备而追加确认。端口状态和存档静默期不能证明页面关闭；不要自动关闭或重新打开页面。完成检查或已有用户确认后由 Codex 执行：

```bash
node --experimental-strip-types packages/plugin-risu/skills/risu-plugin-update/scripts/update-local.ts --risu-root /mnt/d/Projects/risu --apply --page-closed
```

脚本会备份并校验，只替换目标插件代码和版本。报告 `updated` 或 `already-current`，有备份时附上路径，由用户重新打开 Risu。若脚本拒绝写入，读取仓库内的 `packages/plugin-risu/skills/risu-plugin-update/SKILL.md`。复制分发文件和写入已安装插件是两个操作。
