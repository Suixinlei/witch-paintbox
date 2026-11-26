# 默认执行环境

本项目后续默认使用 **WSL2（Bash）** 执行命令，包括文件检索、脚本、Git、构建与测试，不默认使用 PowerShell。若宿主工具入口仍为 Windows shell，通过 `wsl.exe -- bash -lc '<命令>'` 进入 WSL2，并在 `/mnt/d/Projects/witch-paintbox` 工作。

Windows 路径在 WSL2 内转换为 `/mnt/<盘符>/...`。使用 WSL2 内安装的 Node、包管理器和 Python；依赖或工具缺失时先检查项目约定并处理，不静默退回 PowerShell，也不要混用 Windows 与 Linux 的依赖产物。

仅当操作必须访问 Windows 原生能力（如计划任务、本机 Windows 服务部署、Windows 应用或现有 `.ps1` 运维脚本）时，按对应技能使用 Windows 工具；其余工作继续在 WSL2 中完成。若 WSL2 不可用，明确说明具体阻碍。

# 项目参考资料

查找服装 preset、配饰、构图或组合提示词时，使用 [witch-paintbox-reference-search](.agents/skills/witch-paintbox-reference-search/SKILL.md)；它提供有限候选搜索和按来源 ID 展开的只读脚本，避免把全部资料读入上下文。

涉及人物服装设计、新增服装、调整服装 tags 或寻找服饰配件参考时，先查看
[服装参考总目录](docs/references/kisegaeningyou/README.md)。其中收录「更衣人偶」的全部 430 套服装，提供中文类型目录、英文标签索引、原始提示词和本地例图。先检索候选，再按需读取具体条目，避免整库灌入上下文。

涉及构图、姿势、表情、背景、光影或服饰细节时，查看
[渡鸦构图参考总目录](docs/references/raven-composition/README.md)，按原站中文分类检索，再读取命中条目。
需要搭配服装与构图时，先读 [组合指南](docs/references/README.md)。构图、动作、表情、武器和背景用于当轮画面，不写入服装 tags；发型、眼睛和角色标签也不能擅自覆盖当前人物设定。

参考素材不等于已保存的角色设定；实际资料维护继续遵循相应的 Risu／四方维护技能及用户要求。
