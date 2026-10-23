---
name: purchase-app
description: 安装、登录并使用购买 App MCP（采购/记账/待办/项目/预算/统计）。当用户要安装 purchase-app MCP、或要查询/修改购买 App 数据时使用。
---

# 购买 App MCP：安装与使用

把 [purchase-app-mcp](https://github.com/begin2019510/purchase-app-mcp) 安装到当前 agent，引导用户完成一次本机登录，然后用 MCP 工具管理数据。

## 安全规则（必须遵守）

- **绝不询问、记录、回显用户的 App 密码**；不要把密码写进聊天、命令行参数、脚本或日志。
- 需要密码的操作只能由用户在自己的终端完成（本机登录页或 `read -rs` 环境变量方式）。
- 不要把 refresh/access token 写入聊天、文件或仓库；凭据只由程序保存到 `~/.config/purchase-app-mcp/auth.json`（0600）。
- 未经用户明确同意，不执行写操作、删除、批量修改；安装后先只读验证。
- 修改 agent 配置前先备份；不修改与安装无关的配置。
- 不要自行重启 ttyd/tmux 等父进程；重启命令交给用户在独立会话执行。

## 1. 检查环境

```bash
node -v   # 需要 >= 18
npx -v
```

安装规格固定为：`github:begin2019510/purchase-app-mcp`。

## 2. 自动安装（幂等）

优先执行：

```bash
npx -y github:begin2019510/purchase-app-mcp setup
```

它会：

- 在 Claude Code 中把 `purchase-app` 注册为用户级 MCP（已存在则跳过）；
- 把本 skill 安装到 `~/.claude/skills/purchase-app/SKILL.md`；
- 打印登录和重启步骤。

其他 agent / 不想自动改配置：

```bash
npx -y github:begin2019510/purchase-app-mcp setup --print
```

`--print` 只输出 JSON（`mcpServers.purchase-app` 配置 + skill 源/目标路径 + 命令），不会写任何文件。把 `mcpServers` 条目写入该 agent 的 MCP 配置即可。也可以指定 JSON 配置文件：

```bash
npx -y github:begin2019510/purchase-app-mcp setup --agent json --config <该 agent 的 mcp 配置文件>
```

每个 agent 要独立凭据时，加 `--home <独立目录>`（或设置 `PURCHASE_APP_MCP_HOME`），并分别登录。

## 3. 登录（必须，由用户完成）

先检查：

```bash
npx -y github:begin2019510/purchase-app-mcp status
```

若显示未登录：

- **本机有浏览器**：让用户在自己的终端运行 `npx -y github:begin2019510/purchase-app-mcp login`，打开它打印的 `http://127.0.0.1:<port>/login/<一次性串>`，输入 App 账号（默认 `admin`）和密码。
- **远程服务器/无浏览器**：让用户在独立 SSH 终端执行：

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

写操作：`purchase.create/update/delete`、`expense.*`、`todo.*`、`project.*`、`budget.save`、`recurring.update`、`cats.update`。执行前先向用户确认，删除和批量修改必须确认。

注意：`phase.status.set` 依赖 App 公网的 `/api/phases`；若返回“接口返回了网页而不是 JSON”，说明该端点未部署，**不要声称成功**。其余工具不受影响。

## 6. 吊销与排障

- 撤销这个安装的凭据：

  ```bash
  npx -y github:begin2019510/purchase-app-mcp logout
  ```

  它会删除本机凭据并吊销服务端该 refresh token。

- 未登录 / 401：重新执行 `login`。
- 凭据与当前 `PURCHASE_APP_BASE_URL` 不匹配：重新 `login`，或改回原地址。
- 多个 agent 共用同一凭据目录也能工作（刷新令牌有跨进程锁），但要**单独吊销**就给每个 agent 设置不同的 `PURCHASE_APP_MCP_HOME`。
- 审计日志：`~/.config/purchase-app-mcp/audit.log`（0600），记录工具调用，参数已脱敏。
