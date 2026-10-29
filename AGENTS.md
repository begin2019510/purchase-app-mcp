# AGENTS.md — 给任意 agent 的安装与使用说明

本仓库提供 **purchase-app-mcp**：把「个人管家」App 的采购 / 记账 / 待办 / 项目 / 预算 / 统计数据暴露为 MCP 工具。任何 agent（Claude Code、Cursor、IDE agent、自建 agent）都可以按本文件安装和使用。

安装规格始终是 `github:begin2019510/purchase-app-mcp`，要求 Node.js >= 18.17，安装时需要能访问 GitHub 与 npm registry。

## 最重要的一条

**如果用户给了你一条形如 `https://<app>/agent#t=<票据>` 的安装链接，直接运行：**

```bash
npx -y github:begin2019510/purchase-app-mcp install "<链接>"
```

这一条命令会：注册 MCP → 安装 skill → 用票据换取本安装实例独立的凭据 → 调用 `purchase.list` 做只读验证。看到 `INSTALL_OK` 即成功。之后重启当前 agent 会话，让 MCP 加载，再调用 `purchase.list` 确认。

**不要**向用户索要密码，**不要**让用户把 token 发给你，**不要**把链接或 token 写入文件、日志或聊天记录。

## 选择授权方式

| 情况 | 做法 |
|---|---|
| 用户提供了安装链接 | `install "<链接>"`（全自动，推荐） |
| 没有链接，本机有图形界面 | `setup` 后运行 `login`，会自动打开浏览器；由用户自己输入密码 |
| 没有链接，无桌面的远程服务器 | 请用户打开 App →「设置 → 连接 Agent（MCP）」生成链接发来，再走 `install` |
| 用户要求给另一个 agent 授权 | 已登录时运行 `link`，把输出的 `url` 发给对方 |

安装链接由 App v3.0.1+ 生成：10 分钟内有效、只能兑换一次；生成新链接会让旧链接立即失效。票据位于 URL 片段（`#` 之后），不会随请求发送到服务器。兑换失败（过期/已用）时，请用户在 App 里重新生成，不要尝试复用。

## 常用命令

```bash
# 安装并注册（Claude Code 用户级 MCP + skill），幂等
npx -y github:begin2019510/purchase-app-mcp setup

# 只输出 JSON 配置，不写文件（其他 agent / 只看配置）
npx -y github:begin2019510/purchase-app-mcp setup --print

# 写入指定 JSON 配置文件 + skill 目录
npx -y github:begin2019510/purchase-app-mcp setup --agent json --config <文件> --skill-dir <目录>

# 一次性安装链接（全自动授权）
npx -y github:begin2019510/purchase-app-mcp install "<链接>"

# 已登录时给另一个 agent 生成一次性链接
npx -y github:begin2019510/purchase-app-mcp link

# 本机网页登录（有桌面会自动开浏览器）
npx -y github:begin2019510/purchase-app-mcp login

# 状态 / 吊销
npx -y github:begin2019510/purchase-app-mcp status
npx -y github:begin2019510/purchase-app-mcp logout
```

每个 agent 独立凭据：加 `--home <独立目录>`（或设置 `PURCHASE_APP_MCP_HOME`）。凭据保存在该目录的 `auth.json`（目录 0700、文件 0600），只包含 refresh token，不包含密码。

## 安全规则（必须遵守）

1. 绝不询问、记录、回显用户的 App 密码；密码只能由用户在自己的终端/浏览器里输入。
2. 不要打印、转存、提交 refresh token / access token / 安装链接。凭据只由程序写入本机文件。
3. 安装后先调用只读工具验证：`purchase.list`、`expense.list`、`todo.list`、`project.list`、`budget.get`、`analytics.summary`。
4. 写操作（create/update/delete、`budget.save`、阶段状态等）必须先征得用户明确同意；删除与批量修改必须再次确认。
5. 修改 agent 配置前先备份；不要改与安装无关的配置。
6. 不要自行重启 ttyd / tmux 等父进程；需要重启的情况把命令交给用户在独立会话执行。
7. 票据、凭据都按「哪个 agent 用就由哪个 agent 自己持有」处理，禁止在 agent 之间共享同一个 token。

## 工具（27 个）

- 采购：`purchase.list/get/create/update/delete`
- 记账：`expense.list/create/update/delete`
- 待办：`todo.list/create/update/delete`
- 项目：`project.list/get/create/update/delete`、`phase.list`、`phase.status.set`
- 预算：`budget.get`、`budget.save`
- 重复项/分类：`recurring.list/update`、`cats.list/update`
- 统计：`analytics.summary`

`phase.*` 需要 App **3.0.0+**（含此前的 4.0.52–4.0.61）。若返回「接口返回了网页而不是 JSON」，说明目标 App 版本过旧：不要声称成功，先让用户升级 App。

## 排障

| 现象 | 处理 |
|---|---|
| `install` 提示链接无效/过期/已使用 | 让用户在 App 设置页重新生成；不要重试旧链接 |
| 工具返回未登录（401） | 重新 `install "<新链接>"` 或在本机 `login` |
| 凭据与 App 地址不匹配 | 用同一个 App 地址重新授权；不同服务的凭据不会互相发送 |
| `setup` 后 `/mcp` 看不到服务 | 需要用户重启当前 agent 会话；不要自行重启父进程 |
| 无浏览器、无法端口转发 | 用 App 生成的安装链接，这是最省事且安全的远程授权方式 |

更多说明见 [README.md](README.md) 与 [SKILL.md](skills/purchase-app/SKILL.md)。
