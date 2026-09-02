# codex-tg

[English](README.md)

一个轻量的 [Codex CLI](https://github.com/openai/codex) Telegram 桥接服务。
向你的 Telegram Bot 发送消息、照片或文档，Codex 在你的工作区中运行并将结果流式返回到聊天中。

## 功能

- **交互式审批** — 命令执行、文件变更和权限请求会以 Telegram 内联键盘的形式出现，你的决定会让暂停的任务原地恢复。
- **技能分支（Skill Episodes）** — 在 App Server 模式下，每个触发技能的轮次都会将完整的技能指令重新注入上下文窗口，长时间运行的技能会迅速塞满上下文。技能分支通过将任务分叉到独立线程来解决这个问题：技能在隔离环境中运行，结束时只将一份精简摘要注入回主对话。分支可通过 `$skill-name` / `/skill <名称>` 手动启动，也可由隐藏的语义路由器自动触发。
- **附件收发** — 发送照片（JPEG / PNG / WebP）或文档（`.md` / `.txt` / `.json` / `.zip`）进来；Codex 生成的文件会以 Telegram 文档形式返回。长文本会拆分发送，长代码以 `.md` 文件形式发出。
- **持久化线程** — 对话线程按聊天和论坛话题持久保存。`/new` 可重新开始并保留短期上下文；`/resume` 可恢复之前的线程。
- **画像与记忆** — 手动维护的画像文件和自动演化的长期记忆文件会注入每个新线程。后台定期审阅器从对话中提取记忆更新；也可通过 `/memory` 手动管理。
- **每日日志** — 可选的每日收集器会提取当天事件并写入 Memory Gateway 的日志。默认关闭。
- **自主唤醒** — Bot 能按自己的节奏主动发起对话，支持灵活的时间窗口和精确预约。调度尊重清醒时段，并在有真实对话时让步。
- **双后端** — `app-server`（默认）支持交互审批和持久 MCP 连接；`exec` 为兼容回退模式。

## 安装

```bash
npm install
cp .env.example .env && $EDITOR .env   # 至少填写 Bot Token 和你的用户 ID
npm start
```

需要 `codex` 在 PATH 中且已登录（`codex login`）。

要启用自动技能路由，将 `skills.example.json` 复制为 `skills.json`，列出路由可启动的技能，并将 `SKILL_CATALOG_FILE` 指向它。

建议用 systemd 或 tmux 运行，以防 SSH 断开后进程退出：

```ini
# /etc/systemd/system/codex-tg.service
[Unit]
Description=codex-tg
After=network.target

[Service]
WorkingDirectory=/opt/codex-tg
ExecStart=/usr/bin/node src/bot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 命令

| | |
|---|---|
| *（任意文本）* | 发送给 Codex |
| `/new` | 开始新线程（保留最近 10 条用户消息作为上下文） |
| `/new clean` | 开始新线程，不带上下文 |
| `/threads` | 列出可恢复的历史线程 |
| `/resume <编号>` | 恢复 `/threads` 中列出的线程 |
| `/cd <路径>` | 切换工作区（重新开始） |
| `/model [model-id\|default]` | 查看或更改当前聊天的模型 |
| `/effort [级别\|default]` | 查看或更改推理强度 |
| `/compact` | 压缩当前线程上下文 |
| `/usage` | 会话 Token 用量、当前上下文及账户限额 |
| `/memory` | 查看长期记忆及待审阅数量 |
| `/memory refresh` | 立即运行记忆审阅 |
| `/memory forget <n>` | 删除一条记忆 |
| `/skill` | 查看当前技能分支或可路由的技能目录 |
| `/skill <名称>` | 启动一个技能分支 |
| `/skill off` | 结束技能分支并将摘要带回主线程 |
| `/status` | 工作区、线程 ID、轮次计数 |
| `/stop` | 终止正在运行的轮次 |
| `/restart` | 优雅重启 Bot 并加载最新代码 |

## 已知限制

- **长线程会退化。** 历史回放随线程增长。可用 `/compact` 原地压缩摘要，或 `/new` 重新开始（旧线程仍可通过 `/threads` 找回）。
- **每个聊天同时只支持一个轮次。** 并发消息会被拒绝而非排队。
