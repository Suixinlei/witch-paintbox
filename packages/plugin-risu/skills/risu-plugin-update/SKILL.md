---
name: risu-plugin-update
description: 备份并更新本地 Node 自托管 Risu 中已安装的 global-comfy-image 插件，保留聊天、配置、其他插件和图片资料；用于本地插件安装更新，不用于远端同步或仅构建分发文件。
---

# 本地画图插件更新

用户指定 IAB 页面用于调试时，允许自行关闭该调试页、安装后重新打开并验证，不重复询问；其他浏览器中的用户页面仍遵循下文检查规则。

用户偏好：安装更新使用脚本；页面状态优先通过可用浏览器标签页清单只读检查，不默认操作页面。只构建、复制分发文件或只读检查不要求关页。写入已安装插件前，先检查本机 6001 的 Risu 标签页，包含 localhost、回环地址及已知别名。检查覆盖完整、未发现目标页面，且没有已知其他设备仍在使用的证据时，可直接继续。发现页面仍开着时指出具体页面，请用户关闭；检查不可用或覆盖不完整时说明缺口，再请用户确认。用户已确认关闭时直接沿用，不重复检查或询问，也不因假设存在其他设备而追加确认。只有用户明确允许时才可关闭页面；更新完成默认交由用户自行打开。

源码工程是 `/mnt/d/Projects/witch-paintbox/packages/plugin-risu`；`/mnt/d/Projects/risu/plugins/global-comfy-image` 是分发目录。此 skill 与脚本随分发文件一起复制。源码修改仍遵守工程 AGENTS.md，先完成 check、lint 和 E2E，再更新真实实例。`pnpm deploy` 只复制分发文件，不安装到存档。

**最后才确认关页。** 代码、测试、类型检查、构建、分发文件、只读安装预览和回滚准备全部完成，确认可直接安装后，再执行页面检查或请用户关页。确认关闭后只做最新存档读取、并发校验与最终备份、安装和结果校验，不再开发、构建或开始其他任务。需要返工时先停止安装并告知用户可恢复使用，准备完成后再进入最终写入窗口；页面状态未变化时沿用已有确认。安装验收完成后立即告知可重新打开页面。

## 执行

默认在 WSL2 Bash 中使用 Linux 原生 Node.js 22.12+，在源码或分发插件目录中运行（脚本会定位相邻的本地 Risu，也可传 `--risu-root`）：

```bash
# 只读预览；不创建备份、不写存档，可在页面使用期间执行
node --experimental-strip-types ./skills/risu-plugin-update/scripts/update-local.ts

# 页面检查通过或用户已确认关闭后，完成备份、替换和校验
node --experimental-strip-types ./skills/risu-plugin-update/scripts/update-local.ts --apply --page-closed
```

`--page-closed` 是调用方基于上述页面检查或用户确认作出的声明，脚本本身不检测浏览器。浏览器清单只能证明其覆盖范围内的状态；不可把端口状态、静默期或哈希检查当作关页证明。存在已知未关闭页面或检查缺口尚未得到用户确认时，只运行预览；需要用户关页时说明原因是避免浏览器整库写回覆盖更新。

脚本只更新 `save/<hex(database/database.bin)>` 中类型 9、名称 `plugins` 的唯一插件对象的 `script` 与 `versionOfPlugin`。它校验插件身份、版本、分发 SHA-256、原始块边界与写入前文件哈希；非目标插件、目标插件其他字段和所有其他块逐字节/语义校验。未知格式、远程插件块、重复身份或并发变化会停止，不强行转换。备份和验证报告放在 Risu `.local/plugin-updates/<timestamp>/`，不要打印备份中的私密数据。

显示 `already-current` 表示代码与版本已一致，无须重复写入。显示 `updated` 后说明完成情况和备份路径。无须通过 UI 再导入，也不要为验收发送聊天、调用模型或生图。

## 回滚

用户要求回滚且已关闭页面时：

```bash
node --experimental-strip-types ./skills/risu-plugin-update/scripts/update-local.ts --rollback '/mnt/d/Projects/risu/.local/plugin-updates/<timestamp>' --page-closed
```

回滚只恢复目标插件旧代码及旧版本，保留当前聊天、配置与其他插件。当前插件代码已被再次更新时拒绝回滚，避免覆盖其他升级。回滚本身也先备份当前存档。失败时读取错误和报告处理原因，不绕过冲突检查、不把完整旧数据库覆盖新聊天。
