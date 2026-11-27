# 默认执行环境

本项目后续默认使用 **WSL2（Bash）** 执行命令，包括文件检索、脚本、Git、构建与测试，不默认使用 PowerShell。若宿主工具入口仍为 Windows shell，通过 `wsl.exe -- bash -lc '<命令>'` 进入 WSL2，并在 `/mnt/d/Projects/witch-paintbox` 工作。

Windows 路径在 WSL2 内转换为 `/mnt/<盘符>/...`。使用 WSL2 内安装的 Node、包管理器和 Python；依赖或工具缺失时先检查项目约定并处理，不静默退回 PowerShell，也不要混用 Windows 与 Linux 的依赖产物。

仅当操作必须访问 Windows 原生能力（如计划任务、Windows 应用或现有 `.ps1` 脚本）时，按对应技能使用 Windows 工具；其余工作继续在 WSL2 中完成。本机服务运行在 WSL2 的 systemd 用户服务里，部署与验收见[运维技能](.agents/skills/witch-paintbox-operations/SKILL.md)。若 WSL2 不可用，明确说明具体阻碍。

# 默认作用域

本项目的 skill 和规则默认全部放在**项目级**，随仓库维护：

- 规则写在本文件（仓库根目录 `AGENTS.md`），不写 `~/.zcode/AGENTS.md`、`~/.codex/AGENTS.md`。
- skill 放本仓库 `.agents/skills/`，不在 `~/.zcode/skills/`、`~/.agents/skills/`、`~/.codex/skills/` 下建副本或转发入口。
- 新增、拆分或修改 skill 和规则时都按此落位；只有用户明确要求全局生效时才放用户级。

Risu 存档侧的 skill（`risu-academy-add-character` 等）在相邻 Risu 仓库的 `D:\Projects\risu\.agents\skills\`，属于那个仓库的项目级 skill，该仓库的 `AGENTS.md` 记有同样的两条约定；本项目调用它们时同样遵守本文件。

# 默认角色卡

用户提到卡、加人、删人、条目、世界书、xp 等而不加定语时，默认指《学园重生》卡（chaId `c699b607-5be7-4a2f-9749-8304a53b3231`），不是《调教学园》（조교 아카데미）或其他卡。本项目内所有 skill 与规则都按这个默认执行。`add_character.py` 的 `--card` 默认值也是「学园重生」；只有用户点名《调教学园》等其他卡时才传 `--card`。

# 项目参考资料

查找服装 preset、配饰、构图或组合提示词时，使用 [witch-paintbox-reference-search](.agents/skills/witch-paintbox-reference-search/SKILL.md)；它提供有限候选搜索和按来源 ID 展开的只读脚本，避免把全部资料读入上下文。

涉及人物服装设计、新增服装、调整服装 tags 或寻找服饰配件参考时，先查看
[服装参考总目录](docs/references/kisegaeningyou/README.md)。其中收录「更衣人偶」的全部 430 套服装，提供中文类型目录、英文标签索引、原始提示词和本地例图。先检索候选，再按需读取具体条目，避免整库灌入上下文。

涉及构图、姿势、表情、背景、光影或服饰细节时，查看
[渡鸦构图参考总目录](docs/references/raven-composition/README.md)，按原站中文分类检索，再读取命中条目。
需要搭配服装与构图时，先读 [组合指南](docs/references/README.md)。构图、动作、表情、武器和背景用于当轮画面，不写入服装 tags；发型、眼睛和角色标签也不能擅自覆盖当前人物设定。

参考素材不等于已保存的角色设定；实际资料维护继续遵循相应的 Risu／四方维护技能及用户要求。
