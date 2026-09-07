# pi-file-guard

> 在 LLM 执行修改性操作前弹窗确认 / Confirmation dialog before LLM performs modifying operations.

在 LLM 执行修改性操作（`edit` / `write` / 危险 `bash`）前弹出确认菜单，交互与 Pi 的模型选择器一致（方向键选择、回车确认、Esc 取消）。

Before the LLM performs modifying operations (`edit` / `write` / dangerous `bash`), it pops up a confirmation menu. The interaction matches Pi's model picker (arrow keys to select, Enter to confirm, Esc to cancel).

---

## 安装 / Installation

### 方式一：安装到单个项目（推荐先这样试用）/ Method 1: Install into a single project (recommended for a first try)

把 `pi-file-guard/` 整个文件夹（或只复制 `index.ts`）放进目标项目的：

Copy the entire `pi-file-guard/` folder (or just `index.ts`) into:

```
你的项目/.pi/extensions/        （没有这个目录就自己建 / create it if it doesn't exist）
```

然后在 pi 里执行 `/reload`（或重启 pi）即可。

Then run `/reload` in pi (or restart pi).

> 注意：项目级扩展要求**项目已被信任**：首次在项目目录启动 pi 时会询问 "Trust project?"，选择信任后才会加载 `.pi/extensions/`。
>
> Note: Project-level extensions require the **project to be trusted**: when you first start pi in the project directory it will ask "Trust project?". Only after choosing to trust will `.pi/extensions/` be loaded.

### 方式二：全局安装（所有项目生效）/ Method 2: Global install (takes effect in all projects)

把 `pi-file-guard/` 文件夹复制到：

Copy the `pi-file-guard/` folder to:

```
~/.pi/agent/extensions/          # Windows: C:\Users\你的用户名\.pi\agent\extensions\
```

重启 pi 或 `/reload` 后，所有项目都会自动加载，且不依赖项目信任。

After restarting pi or running `/reload`, it is automatically loaded in all projects and does not depend on project trust.

### 方式三：快速试用（仅本次运行，不落盘）/ Method 3: Quick try (current run only, not persisted)

```bash
pi -e C:/完整路径/pi-file-guard/index.ts
# 或 / or
pi -e C:/完整路径/.pi/extensions/pi-file-guard.ts
```

注意：`-e` 建议用**绝对路径**（相对路径在部分启动方式下解析不到）。适用于临时体验，不推荐长期使用。

Note: `-e` is recommended to use an **absolute path** (relative paths may not resolve under some startup methods). Good for a temporary try, not recommended for long-term use.

### 方式四：团队分享（git 仓库 + pi 包）/ Method 4: Team sharing (git repo + pi package)

本文件夹已包含 pi 包清单（`package.json` 的 `pi.extensions` 字段），推送到 git 仓库后，同事在任何项目里：

This folder already contains a pi package manifest (`pi.extensions` field in `package.json`). After pushing to a git repo, teammates can run this in any project:

```bash
pi install git:https://github.com/oahcz-7891/pi-file-guard.git
pi list          # 确认安装 / verify installation
```

---

## 验证是否生效 / Verify it works

1. 底部状态栏出现 `guard: ask (edit/write/bash)`；
   The bottom status bar shows `guard: ask (edit/write/bash)`;
2. 输入 `/pi-file-guard`，能看到当前拦截状态；
   Run `/pi-file-guard` to see the current interception status;
3. 让 LLM 写一个文件，应弹出确认菜单。
   Ask the LLM to write a file—a confirmation menu should appear.

---

## 常用控制命令 / Common control commands

| 命令 / Command | 作用 / Action |
|------|------|
| `/pi-file-guard` | 显示当前状态 / Show current status |
| `/pi-file-guard on\|off` | 启用 / 禁用拦截 / Enable / disable interception |
| `/pi-file-guard edit\|write\|bash` | 逐个切换是否拦截对应工具 / Toggle interception per tool |
| `/pi-file-guard reset` | 重置本次会话的"允许/拒绝"记忆 / Reset this session's "allow/deny" memory |

---

## 说明 / Notes

- 非交互模式（`pi -p`、`--mode json`）下无法弹窗，修改类操作默认**直接拦截**（fail-safe 设计）。
  In non-interactive mode (`pi -p`, `--mode json`) dialogs are not possible; modifying operations are **intercepted by default** (fail-safe design).
- 危险 bash 才会询问（`rm -rf`、`sudo`、`chmod/chown`、`dd/mkfs` 等），普通命令不打扰。
  Only dangerous bash is asked about (`rm -rf`, `sudo`, `chmod/chown`, `dd/mkfs`, etc.); normal commands are not interrupted.
- 插件不增加模型 token 消耗。
  The plugin does not add to model token consumption.
