# pi-file-guard

在 LLM 执行 `edit` / `write` / 危险 `bash` 前弹出确认菜单（方向键选择、回车确认、Esc 取消）。危险度分 5 档可调。

### 安装

- **单项目**：把 `index.ts` 放进 `你的项目/.pi/extensions/`，然后 `/reload`。（项目需先选 Trust）
- **全局**：放进 `~/.pi/agent/extensions/`，重启或 `/reload`，所有项目生效。
- **试用**：`pi -e <绝对路径>/index.ts`
- **团队**：`pi install git:https://github.com/oahcz-7891/pi-file-guard.git`

### 危险度等级

`tier <= level` 就弹窗；tier 数字越小越危险。

| level | 拦截 |
|---|---|
| 0 off | 不拦 |
| 1 low | `sudo` / `dd` / `curl \| sh` 等灾难性 |
| **2 medium（默认）** | + `rm` / `mv` / `chmod` / `git reset --hard` |
| 3 high | + 全部 edit / write / 文件创建 |
| 4 paranoid | + 所有工具调用 |

敏感路径（`.env`、`.git/`、`.ssh/`、`package.json`、lockfile、CI 配置）会升一档；**当前文件夹外**的路径再升一档（比项目内同类操作更危险）。

### 命令

| 命令 | 作用 |
|---|---|
| `/pi-file-guard` | 查看状态 |
| `/pi-file-guard level` / `level 2` | 选择 / 直接设置等级 |
| `/pi-file-guard +` / `-` | 调严格度 |
| `/pi-file-guard on` / `off` | 开启 / 关闭 |
| `/pi-file-guard edit\|write\|bash` | 静音某工具（永不拦截） |
| `/pi-file-guard reset` | 清除本会话"允许/拒绝"记忆 |

### 说明

- 非交互模式（`pi -p`、`--mode json`）无法弹窗，修改类操作默认拦截（fail-safe）。
- **项目内 / 项目外分开记忆**：选「Yes, and allow all … this session」只对当前范围生效；允许项目内改动不会顺带放行项目外改动。
- 等级按会话保存，`/reload` 与切分支不丢；项目默认值写在 `.pi/pi-file-guard.json`：`{ "level": 2 }`。
- 不增加模型 token 消耗。

### 样式与文档

- 设计稿：`preview-danger-level.html`（危险度）、`preview-claude.html`（基础弹窗）
- 方案：`danger-level-plan.md`、`claude-style-plan.md`
