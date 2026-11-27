# WSL2 开发与维护

默认在 Ubuntu WSL2 的 `/mnt/d/Projects/witch-paintbox` 工作，使用 Linux 原生 Node.js 22.12+、pnpm 11.25.0、Python 3 和 Git。Windows 的 `D:\Projects\witch-paintbox` 与这里是同一份源码。不要从 WSL PATH 误用 `/mnt/c/.../pnpm`，也不要混用 Windows 安装的 node_modules。

## 准备环境

从 Windows 工具入口执行 `wsl.exe -- bash -lc 'cd /mnt/d/Projects/witch-paintbox && <命令>'`。已在 WSL Bash 中则直接运行：

```bash
cd /mnt/d/Projects/witch-paintbox
node --version
command -v node pnpm python3 git
```

本机使用官方 Linux Node 22，装在 `~/.local/lib/nodejs/`，命令入口在 `~/.local/bin`。Ubuntu 自带的部分 Node 构建不含 TypeScript 支持，执行项目 `.ts` 维护脚本会报 `ERR_NO_TYPESCRIPT`。新 WSL 环境若遇到这种情况，先用当前 Linux Node 执行 `node scripts/install-wsl-node.mjs`，它下载官方 Node 22、核验 SHA-256 后安装到当前 Linux 用户目录，再重新打开登录 shell。

若 pnpm 来自 Windows 或旧版 Corepack 不能加载 pnpm 11 的动态导入，使用支持 Node 22.12+ 的 Corepack 版本安装 Linux 用户级入口：

```bash
npm install --global --prefix "$HOME/.local" corepack@0.34.6
export PATH="$HOME/.local/bin:$PATH"
corepack enable --install-directory "$HOME/.local/bin"
pnpm --version
```

保持登录 shell 的 PATH 优先包含 `$HOME/.local/bin`。本机 `~/.profile` 已有这一规则；普通非登录 shell 可手动执行上面的 export。

新环境运行 `node scripts/setup-wsl.mjs`。从 Windows 依赖迁移时运行：

```bash
node scripts/setup-wsl.mjs --migrate
```

迁移会先将根目录与各包现有 node_modules 移到 `.local/wsl-dependency-backups/<时间>/`，再用锁文件安装 Linux 依赖；不删除旧依赖、不改锁文件。失败时保留备份并停止。迁移只执行一次，后续普通安装不传 `--migrate`。

## Git 身份与凭据

本机 WSL Git 已沿用原 Windows Git 的提交身份。Linux 的 `~/.local/bin/git-credential-manager` 链接到 Windows 已安装的 Git Credential Manager，仓库使用 `credential.helper=manager`；这样 Linux Git 可复用已有 Windows 凭据，Windows Git 也继续识别同一个 helper 名称。不要在文档、脚本或远端 URL 中写入访问令牌。

新 WSL 环境若已安装 Windows Git Credential Manager，可在确认目标存在后建立桥接：

```bash
ln -s '/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe' "$HOME/.local/bin/git-credential-manager"
git config --local credential.helper manager
```

已有同名入口时先检查其目标，不重复覆盖。提交身份使用用户已有的 name/email；配置缺失时先读取原 Windows Git 配置，不虚构身份。推送使用普通快进，不强推。

## 验证

```bash
node scripts/check-wsl.mjs
pnpm build
pnpm --filter @witch-paintbox/plugin-risu lint
pnpm --filter @witch-paintbox/plugin-sifang exec playwright install chromium
pnpm --filter @witch-paintbox/plugin-risu exec playwright install chromium
pnpm test
```

Linux 浏览器缺少系统库时，使用 Playwright 的 `install-deps chromium` 为该 WSL 发行版安装依赖。测试仅使用各自临时端口和测试数据，不应触发真实 NAI 出图。

需要确认现有服务可访问时，运行 `node scripts/check-wsl.mjs --service`。它只读检查管理员 API，不打印令牌或资料内容。本机 WSL2 使用 mirrored 网络：WSL 内监听的 `127.0.0.1:4783`、`127.0.0.1:6001` 在 Windows 侧同样可以访问，WSL 也能访问 Windows 上的回环端口。Windows 的 `Get-NetTCPConnection` 只报告 Windows 自己的监听，看不到 WSL 里的端口。其他机器需单独验证网络，不能为连通而盲目公开服务监听地址。

维护脚本通过 `scripts/windows-environment.mjs` 读取 `%LOCALAPPDATA%/WitchPaintbox/service.env`，从 WSL 查询 Windows 环境目录并转换挂载路径；也可设置 `PAINTBOX_ENV_FILE` 指向现有文件。环境变量显式设置优先，不要生成新令牌覆盖现有连接。

Risu 只读解码器默认定位相邻的 `/mnt/d/Projects/risu`；需要其他位置时用 `--workspace`。文件参数在 WSL 下使用 `/mnt/...`，Windows 文件选择器仍使用盘符路径。

## 本机服务的运行方式

本机服务运行在 WSL2 的 systemd 用户服务 `witch-paintbox.service` 里，用 `.agents/skills/witch-paintbox-operations/scripts/update-server.mjs -Apply` 部署，验收和回滚以[运维技能](../.agents/skills/witch-paintbox-operations/SKILL.md)为准。

- 发布目录在 `~/.local/share/witch-paintbox/releases/`，每个版本带独立的 Linux 生产依赖，不使用开发目录的 node_modules；`~/.local/share/witch-paintbox/current` 指向在用的版本。
- 环境文件是 `~/.config/witch-paintbox/service.env`，每次部署从 `%LOCALAPPDATA%/WitchPaintbox/service.env` 重新生成：令牌原样沿用，盘符路径换算成 `/mnt`。数据目录仍是 `D:\WitchPaintbox\data`，在 WSL 里是 `/mnt/d/WitchPaintbox/data`，没有搬迁。
- 用户服务随 WSL 实例启动。WSL 实例没有会话时会自动关机，所以 Windows 计划任务 `Witch Paintbox Local Service` 在登录时启动一个不显示窗口的 `wsl.exe` 保活会话，运行 `~/.local/share/witch-paintbox/keepalive.sh`。本机没有免密 sudo，开不了 linger，常驻依赖这个保活。
- 查看状态用 `systemctl --user status witch-paintbox.service`，日志用 `journalctl --user -u witch-paintbox.service -f`。

仍然必须调用 Windows 的只有这个计划任务，部署脚本通过 `scripts/service-task.ps1` 桥接。迁移前的任务定义备份在 `%LOCALAPPDATA%/WitchPaintbox/backups/task-before-wsl-*.xml`；原先的 Windows 发布目录已删除，要回退到 Windows 托管，得先用 Windows 版 pnpm 重新建一个。`%LOCALAPPDATA%/WitchPaintbox/service.env` 仍是令牌与设置的来源，每次部署都从它生成 WSL 版环境文件，不要删除。

Risu 插件安装更新是跨平台 TypeScript 脚本，直接由 WSL Node 执行；不需要 PowerShell，也不因为默认 WSL 而略过其关页确认要求。用法见 [插件更新技能](../packages/plugin-risu/skills/risu-plugin-update/SKILL.md)。

## 本地参考库

服装与构图检索见 [组合指南](references/README.md) 和仓库的 [参考检索 skill](../.agents/skills/witch-paintbox-reference-search/SKILL.md)。参考库同步、离线核对和查询脚本可直接使用 WSL Node；图片与原始提示词共用同一份 docs 文件，无需另复制一份到 Linux home。
