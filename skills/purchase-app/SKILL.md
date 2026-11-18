---
name: purchase-app
description: 安装、登录并使用购买 App MCP（采购/记账/待办/项目/预算/统计）。当用户要安装 purchase-app MCP、拿到一次性安装链接、或要查询/修改购买 App 数据时使用。
---

# 购买 App MCP：安装与使用

把 [purchase-app-mcp](https://github.com/begin2019510/purchase-app-mcp) 安装到当前 agent，引导用户完成一次本机登录，然后用 MCP 工具管理数据。

## 安全规则（必须遵守）

- **绝不询问、记录、回显用户的 App 密码**；不要把密码写进聊天、命令行参数、脚本或日志。
- 需要密码的操作只能由用户在自己的终端完成（本机登录页或 `read -rs` 环境变量方式）。
- 不要把 refresh/access token 写入聊天、文件或仓库；凭据只由程序保存到 `~/.config/purchase-app-mcp/auth.json`（0600）。
- 写操作分 **T0 / T1**（v1.4.0）：T0（创建、定点、推进、代写优缺点等）用户一句话意图即可执行；**T1（删除/取消/回退/终态/硬删/覆盖文档）必须先向用户展示一行预览（对象+后果+不可逆点），得到明确回复后再带 `confirm` 调用**，`confirm` 精确等于目标展示名。安装后先只读验证。
- 修改 agent 配置前先备份；不修改与安装无关的配置。
- 不要自行重启 ttyd/tmux 等父进程；重启命令交给用户在独立会话执行。

## 0. 先判断授权方式（由 agent 自己选）

| 用户给了什么 | 怎么做 |
|---|---|
| App 生成的安装链接（`https://…/agent#t=…`） | 直接走「1. 安装链接」全自动流程，**不要**再让用户登录 |
| 没有链接，但本机能开浏览器 | 走「2. 自动安装」+「3. 本机登录」（`login` 会自动打开浏览器） |
| 没有链接，且是无桌面的远程服务器 | 请用户打开 App →「设置 → 连接 Agent（MCP）」生成链接发来，然后走「1」；不要让用户把密码发到聊天里 |

### 安装链接流程（全自动，不需要密码）

```bash
npx -y github:begin2019510/purchase-app-mcp install "<用户给的链接>"
```

一条命令完成：注册 MCP、安装 skill、用票据换取本安装实例独立的凭据、用 `purchase.list` 做只读验证。看到 `INSTALL_OK` 即成功。

- 链接 **10 分钟内有效、只能使用一次**；失败或被使用过就请用户在 App 里重新生成。
- 票据放在 URL 的 `#` 片段里，不会随请求发给服务器；也不要把它转存到文件、日志或聊天记录里。
- 全程不需要、也不应索要用户的 App 密码。
- 每个 agent 用各自生成的链接 → 各自独立的 refresh token，可单独 `logout` 吊销。

已登录的安装可以为另一个 agent 生成链接：

```bash
npx -y github:begin2019510/purchase-app-mcp link
```

输出 JSON：`{ ok, url, expiresAt, command }`，把 `url` 交给另一个 agent 即可。

## 1. 检查环境

```bash
node -v   # 需要 >= 18
npx -v
```

安装规格固定为：`github:begin2019510/purchase-app-mcp`。

## 2. 自动安装（幂等）

**Claude Code**（安装 MCP + skill）：

```bash
npx -y github:begin2019510/purchase-app-mcp setup
```

它会：

- 在 Claude Code 中把 `purchase-app` 注册为用户级 MCP（已存在且配置一致则跳过）；
- 把本 skill 安装到 `~/.claude/skills/purchase-app/SKILL.md`；
- 打印登录和重启步骤。

**其他 agent**（不想自动改 `~/.claude.json`）：先取配置，再写入该 agent 自己的 MCP 配置：

```bash
npx -y github:begin2019510/purchase-app-mcp setup --print
```

`--print` 只输出 JSON（`mcpServers.purchase-app` 配置 + skill 源/目标路径 + 命令），不会写任何文件。把 `mcpServers` 条目写入该 agent 的 MCP 配置；skill 可从 `skill.pageUrl`/`skill.sourceUrl` 获取。也可以指定 JSON 配置文件：

```bash
npx -y github:begin2019510/purchase-app-mcp setup --agent json --config <该 agent 的 mcp 配置文件>
```

每个 agent 要独立凭据时，加 `--home <独立目录>`（或设置 `PURCHASE_APP_MCP_HOME`），并分别登录；skill 目录不同时加 `--skill-dir <该 agent 的 skills 目录>`。

## 3. 登录（必须，由用户完成）

先检查：

```bash
npx -y github:begin2019510/purchase-app-mcp status
```

若显示未登录（且用户没有提供安装链接）：

- **本机有浏览器**：运行 `npx -y github:begin2019510/purchase-app-mcp login`。有图形界面时会自动打开登录页；否则打印 `http://127.0.0.1:<port>/login/<一次性串>`，让用户自己打开并输入 App 账号（默认 `admin`）和密码。
- **远程服务器/无浏览器**：优先请用户在 App 里生成一次性安装链接，改用 `install <链接>`。也可以用独立 SSH 终端执行：

  ```bash
  read -rs PURCHASE_APP_PASSWORD
  export PURCHASE_APP_PASSWORD
  PURCHASE_APP_MCP_HOME=<与 MCP 配置一致的目录> \
    npx -y github:begin2019510/purchase-app-mcp login
  unset PURCHASE_APP_PASSWORD
  ```

  或让用户做 SSH 端口转发后打开登录页。**不要代替用户输入密码，也不要向用户索要密码。**

登录后再次 `status`，确认显示“已登录”。登录只需要一次；access token 自动续期，refresh token 30 天有效并轮换。

## 4. 让 agent 加载 MCP

- Claude Code：执行过 `setup` 后，需要**用户重启会话**才能在 `/mcp` 看到新服务器。把重启命令交给用户，不要自行重启父进程。
- 其他 agent：按该 agent 的要求重新加载 MCP 配置。
- 验证：调用只读工具 `purchase.list`，能返回数据即成功。

## 5. 使用工具

只读优先：`purchase.list`、`expense.list`、`todo.list`、`project.list`、`budget.get`、`analytics.summary`。
`purchase.list/get` 与 `analytics.summary` 优先读 `/api/needs`（needStatus + 全部 orders/suppliers）；旧 App 自动回退 `/api/items`。`status` 可用需求状态/子单状态/旧 8 态。列表统一按日期倒序（最新在前），`limit=N` 恒为最新 N 条。

写操作分层：

- **T0（直接写）**：`purchase.create`（含 `compareOnly`）、`purchase.decide`、`supplier.add/update`、`order.transition` 正向、`order.update`、`expense.create/update`、`todo.create/update` 与软删、`project.create/update`、`budget.save`、`phase.status.set`、普通字段 `purchase.update`。用户描述意图后即可执行。
- **T1（二次授权）**：`purchase.delete/cancel/undecided`、终态 `purchase.update`、`supplier.delete`、`order.transition`→已退/已取消/已归档、`project.delete`、`expense.delete`、`todo.delete(purge=true)`、`cats.update`、`recurring.update`。

**T1 铁律**：先给用户一行预览（对象 + 后果 + 不可逆点）→ 等明确同意 → 再调用并传 `confirm`：

| 操作 | confirm 必须等于 |
|------|------------------|
| 采购删除/取消/回退定点/终态更新 | 需求名称 |
| 供应商删除 | 供应商名称 |
| 子单进终态 | 父需求名称 |
| 项目删除 | 项目名称 |
| 记账删除 | 备注（无备注则 ID） |
| 待办硬删 | 待办标题 |
| 分类/重复项覆盖 | `覆盖确认` |

不传或传错 `confirm` 时 MCP 会报错并附目标摘要，**不会执行**。诚实边界：MCP 无法验证用户是否真的点头——请把预览写进对话，让同意可见。

注意：`phase.status.set` 依赖 App 公网的 `/api/phases`。App 3.0.0+（含此前 4.0.52–4.0.61）已部署该端点；若返回“接口返回了网页而不是 JSON”，说明目标 App 版本过旧，**不要声称成功**，先让用户升级 App。

## 6. 吊销与排障

- 撤销这个安装的凭据：

  ```bash
  npx -y github:begin2019510/purchase-app-mcp logout
  ```

  它会删除本机凭据并吊销服务端该 refresh token。

- 未登录 / 401：重新执行 `login`，或用新的安装链接重新 `install`。
- `install` 提示「安装链接无效、已过期或已被使用」：链接 10 分钟有效且只能兑换一次。请用户在 App「设置 → 连接 Agent（MCP）」重新生成，不要重试旧链接。
- 凭据与当前 `PURCHASE_APP_BASE_URL` 不匹配：重新 `login`，或改回原地址。
- 多个 agent 共用同一凭据目录也能工作（刷新令牌有跨进程锁），但要**单独吊销**就给每个 agent 设置不同的 `PURCHASE_APP_MCP_HOME`。
- 审计日志：`~/.config/purchase-app-mcp/audit.log`（0600），记录工具调用，参数已脱敏。
