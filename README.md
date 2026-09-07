# pi-file-guard 插件 — 安装说明

在 LLM 执行修改性操作（`edit` / `write` / 危险 `bash`）前弹出确认菜单，交互与 Pi 的模型选择器一致（方向键选择、回车确认、Esc 取消）。

## 方式一：安装到单个项目（推荐先这样试用）

把 `pi-file-guard/` 整个文件夹（或只复制 `index.ts`）放进目标项目的：

```
你的项目/.pi/extensions/        （没有这个目录就自己建）
```

然后在 pi 里执行 `/reload`（或重启 pi）即可。

> 注意：项目级扩展要求**项目已被信任**：首次在项目目录启动 pi 时会询问 "Trust project?"，选择信任后才会加载 `.pi/extensions/`。

## 方式二：全局安装（所有项目生效）

把 `pi-file-guard/` 文件夹复制到：

```
~/.pi/agent/extensions/          # Windows: C:\Users\你的用户名\.pi\agent\extensions\
```

重启 pi 或 `/reload` 后，所有项目都会自动加载，且不依赖项目信任。

## 方式三：快速试用（仅本次运行，不落盘）

```bash
pi -e C:/完整路径/pi-file-guard/index.ts
# 或
pi -e C:/完整路径/.pi/extensions/pi-file-guard.ts
```

注意：`-e` 建议用**绝对路径**（相对路径在部分启动方式下解析不到）。适用于临时体验，不推荐长期使用。

## 方式四：团队分享（git 仓库 + pi 包）

本文件夹已包含 pi 包清单（`package.json` 的 `pi.extensions` 字段），推送到 git 仓库后，同事在任何项目里：

```bash
pi install git:https://github.com/你的账号/pi-file-guard.git
pi list          # 确认安装
```

## 验证是否生效

1. 底部状态栏出现 `guard: ask (edit/write/bash)`；
2. 输入 `/pi-file-guard`，能看到当前拦截状态；
3. 让 LLM 写一个文件，应弹出确认菜单。

## 常用控制命令

| 命令 | 作用 |
|------|------|
| `/pi-file-guard` | 显示当前状态 |
| `/pi-file-guard on\|off` | 启用 / 禁用拦截 |
| `/pi-file-guard edit\|write\|bash` | 逐个切换是否拦截对应工具 |
| `/pi-file-guard reset` | 重置本次会话的"允许/拒绝"记忆 |

## 说明

- 非交互模式（`pi -p`、`--mode json`）下无法弹窗，修改类操作默认**直接拦截**（fail-safe 设计）。
- 危险 bash 才会询问（`rm -rf`、`sudo`、`chmod/chown`、`dd/mkfs` 等），普通命令不打扰。
- 插件不增加模型 token 消耗。