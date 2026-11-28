---
name: witch-paintbox-operations
description: Use when implementing changes to the Witch Paintbox service or its management UI, and for deployment, restart, status checks, verification, or plugin release in this repo. Apply and verify service changes on the local WSL2 instance before handing back. Also covers GitHub releases of 四方世界, local Risu plugin updates, local Risu config writes and frontend deployments, and checking whether the local service or RisuAI is running.
---

# 魔女画匣三端运维

默认从 WSL2 的 `/mnt/d/Projects/witch-paintbox` 运行，使用 Linux 原生 Node 和 pnpm。环境准备与依赖隔离见 [WSL2 指南](../../../docs/DEVELOPMENT-WSL2.md)。本机服务运行在 WSL2 的 systemd 用户服务里，安装、构建、测试、发布目录和切换都在 WSL2 完成；只有登录时拉起保活会话的那个 Windows 计划任务通过 powershell.exe 桥接。宿主工具入口是 Git Bash（MSYS）时写成 `MSYS_NO_PATHCONV=1 wsl.exe -- bash -lc '…'`：不加前缀时以 `/` 开头的参数会被改写成 `C:/Program Files/Git/…`，报 `bash: line 1: C:/Program: No such file or directory`。

- 改了独立服务、管理台或服务实际加载的共享运行时代码，就在同一轮完成本机部署和验收，包括从 Risu 发起、实际由服务实现的功能。用户明确要求只改代码或暂缓上线时，按该要求执行。
- GitHub 发布四方插件和写入本机 Risu 已安装插件走各自流程。用户同时要求部署服务和发布四方时，先准备发布提交，在同一份待发布代码上部署和验证服务，再推 GitHub。

## 状态检查

只问服务在不在时跑这一条，两段都只读：`update-server.mjs` 不带 `-Apply` 只经接口读配置、队列、图片历史和 Risu 偏好，`~/.config/witch-paintbox/service.env` 内容一致就不写；`risu-service.sh status` 只读状态并回探隧道。直接跑，不必先读脚本确认。

```bash
MSYS_NO_PATHCONV=1 wsl.exe -- bash -lc 'uptime -s; cd /mnt/d/Projects/witch-paintbox && node .agents/skills/witch-paintbox-operations/scripts/update-server.mjs; /mnt/d/Projects/risu/tools/wsl2/risu-service.sh status'
```

- 画匣：`status` 为 `healthy`、`unit` 为 `active`、`keepalive` 为 `true` 即正常；`idle: false` 只是队列里有任务，不是故障。报 `not-running` 时用下面的 `systemctl --user status` 和日志定位。
- Risu：`service: active` 即正常；隧道行括号里的 `{"status":"incorrect"}` 是未带凭据的探测回包，不是故障。
- `wsl.exe` 会把已关机的 WSL 实例拉起来，画匣服务随之自启；开头的 `uptime -s` 若就是刚才，这个 `active` 是检查带出来的，回报时照实说。只想看实例在不在，用 `wsl.exe --list --running | tr -d '\0'`，它不启动实例（中文输出是乱码，认 `Ubuntu` 那行）。

## Server

本机服务改动完成后，执行以下命令。若 shell 返回进程会话，等待该会话并读取最终状态。

```bash
node .agents/skills/witch-paintbox-operations/scripts/update-server.mjs -Apply
```

省略 `-Apply` 时只做只读的状态检查并输出 JSON，见「状态检查」。`-Apply` 在 WSL2 构建并跑服务测试，在 `~/.local/share/witch-paintbox/releases/` 下建带独立 Linux 生产依赖的发布目录，用临时端口和空数据预检。建议在无人发起新任务的时段操作。脚本看到队列空闲后切换 `current` 并重启 systemd 用户服务 `witch-paintbox.service`，沿用 `%LOCALAPPDATA%/WitchPaintbox/service.env` 的令牌与设置（每次部署重新生成 `~/.config/witch-paintbox/service.env`，盘符路径换算成 `/mnt`，数据目录不变）。验收包括端口 4783 的新进程、管理页、权限、配置版本、历史图片和 Risu 偏好。仅在报告 `updated` 时确认部署成功。若失败，按脚本结果区分旧服务仍在、已回退或回退失败。验收使用现有记录，无需真实出图。

部署用的是工作区的现状，未提交的改动会原样上线；脚本发现 `packages/` 下有未提交改动时会在标准错误里列出，并在结果的 `uncommitted` 字段里返回。同一工作区常有并行会话在开发，动手前先看这份清单，不要把别人没写完的功能一并部署。

查看状态和日志：`systemctl --user status witch-paintbox.service`、`journalctl --user -u witch-paintbox.service -f`。

**托管方式。** 用户服务随 WSL 实例启动，而 WSL 实例在没有会话时会自动关机，所以 Windows 计划任务 `Witch Paintbox Local Service` 在登录时启动一个不显示窗口的 `wsl.exe` 保活会话（运行 `~/.local/share/witch-paintbox/keepalive.sh`）。本机没有免密 sudo，开不了 linger，常驻依赖这个保活；部署脚本确认它在跑，不在就启动计划任务。停止该计划任务只会结束它的控制台宿主，保活循环会继续运行，服务的启停一律用 `systemctl --user`。迁移前的任务定义备份在 `%LOCALAPPDATA%/WitchPaintbox/backups/task-before-wsl-*.xml`，但 Windows 版发布目录已经删除，不再有可直接切回的 Windows 托管版本。

## 四方世界

1. 核对 `origin` 为 `Suixinlei/witch-paintbox`。从远端取回 `sifang-standalone-service`，以它作为发布基线，保留远端提交。检查根目录 `manifest.json`、`packages/plugin-sifang/manifest.json` 和包版本一致，版本高于上次已发布的清单。
2. 运行 `pnpm --filter @witch-paintbox/plugin-sifang build`、`pnpm test:sifang` 和 `pnpm test:sifang:browser`。提交发布范围内的源码、根清单及 `packages/plugin-sifang/dist/`。确保根清单的 `js` 指向已提交的产物。
3. 用户授权发布后，执行 `git push origin HEAD:refs/heads/sifang-standalone-service`。只做快进。用 `git ls-remote origin refs/heads/sifang-standalone-service` 核对 SHA，再回报版本、分支和提交。用户自行在四方点「检查更新」并安装。

## Risu

**关页确认放在最终写入前。** 插件安装、存档配置写入或前端产物切换需要关页时，先完成代码与补丁、测试、类型检查、构建、只读预演及回滚准备，确认已可直接执行最终写入，再检查页面状态或请用户关页。不要为了并行准备工作提前让用户关闭页面。

用户确认关页后，立即进入写入窗口：只做重读最新存档、并发校验与最终备份、实际写入或产物切换、必要的重启及结果验收；不再开始开发、构建、广泛测试或其他独立任务。若发现需要回头修改或重建，停止写入并告诉用户可先恢复使用；准备完成后再进入最终写入窗口。已有确认且页面状态未变化时不重复询问。验收完成后立即告知可重新打开页面，不让用户等待后续独立工作。

存档补丁必须基于最终写入时的最新数据生成或核对哈希；准备期间用户继续聊天，不得拿旧快照覆盖新消息。

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
