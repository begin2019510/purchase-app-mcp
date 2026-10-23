# purchase-app-mcp

把「个人管家」App 的**采购 / 记账 / 待办 / 项目 / 预算 / 统计**数据以 [MCP](https://modelcontextprotocol.io) 工具暴露给任意 agent（Claude Code、Cursor、IDE agent、自建 agent 均可）。

每个安装实例用自己的 App 账号登录，凭据只存本机；**仓库里没有任何硬编码 token / 密码 / 服务端密钥**。

## 安全模型（如何保证受信）

| 保证 | 做法 |
|------|------|
| 必须鉴权 | 未登录时所有数据工具返回 401 类错误，必须先 `login` |
| 每安装独立凭据 | 每次登录换取独立的 refresh token（30 天，轮换），存本机 `auth.json`（0600） |
| 不共享写死 token | 代码与仓库中无任何 token；登录用 App 账号密码，密码**不落盘、不写日志** |
| 可单独吊销 | `logout` 删除本机凭据并吊销服务端该 refresh token，不影响其他安装 |
| 最小权限 | 只调用 App 已公开的业务 API；无用户管理、无部署/重启、无 shell、无数据库直连 |
| 传输安全 | 只接受 HTTPS App 地址（本机调试才允许 `http://127.0.0.1`）；登录页只监听 127.0.0.1 |
| 可审计 | 本机 `audit.log`（0600）记录每次工具调用，参数自动脱敏；App 侧另有操作日志 |

信任边界：安装了这个 MCP 且完成登录的 agent，拥有该 App 账号的数据读写权限。请只在自己信任的 agent 中配置；不再使用时执行 `logout`。

## 安装

### Claude Code

```bash
claude mcp add purchase-app -- npx -y github:begin2019510/purchase-app-mcp
```

### 通用 MCP 客户端（JSON）

```json
{
  "mcpServers": {
    "purchase-app": {
      "command": "npx",
      "args": ["-y", "github:begin2019510/purchase-app-mcp"]
    }
  }
}
```

Cursor：写入 `~/.cursor/mcp.json`；其他客户端使用各自的 `mcpServers` 配置格式。

### 从源码运行

```bash
git clone https://github.com/begin2019510/purchase-app-mcp.git
cd purchase-app-mcp
npm install
node bin/purchase-app-mcp.js login
```

## 登录（必须，一次即可）

```bash
npx -y github:begin2019510/purchase-app-mcp login
```

终端会打印一个 `http://127.0.0.1:<port>/login/<一次性随机串>` 地址。在浏览器打开，输入 App 账号（默认 `admin`）和密码即可。

- 密码只用于向 App 的 HTTPS 登录接口换取 token，**不会保存**。
- 只把 refresh token 写入 `~/.config/purchase-app-mcp/auth.json`（目录 0700、文件 0600）。
- access token 24 小时有效、自动续期；refresh token 30 天有效、每次续期轮换。
- 登录后无需重启 agent：MCP 进程会在下一次工具调用时自动读取新凭据。

**无浏览器的服务器**（二选一）：

```bash
# 方式 1：SSH 端口转发（login 会打印实际端口）
ssh -L 127.0.0.1:<port>:127.0.0.1:<port> user@server
# 然后在本地浏览器打开 login 打印的地址

# 方式 2：一次性环境变量登录（密码不落盘，注意 shell 历史/进程环境）
read -rs PURCHASE_APP_PASSWORD
export PURCHASE_APP_PASSWORD
npx -y github:begin2019510/purchase-app-mcp login
unset PURCHASE_APP_PASSWORD
```

## 多 agent 隔离（推荐）

默认所有 agent 共用当前系统用户的凭据目录。若希望每个 agent 独立登录、独立吊销，在各自的 MCP 配置里指定独立目录：

```json
{
  "mcpServers": {
    "purchase-app": {
      "command": "npx",
      "args": ["-y", "github:begin2019510/purchase-app-mcp"],
      "env": {
        "PURCHASE_APP_MCP_HOME": "/home/me/.config/purchase-app-mcp/work-agent"
      }
    }
  }
}
```

然后分别执行：

```bash
PURCHASE_APP_MCP_HOME=/home/me/.config/purchase-app-mcp/work-agent \
  npx -y github:begin2019510/purchase-app-mcp login
```

共用同一目录也安全：refresh token 轮换有跨进程文件锁，不会互相踢下线；只是无法按 agent 单独吊销。需要单独吊销时用独立目录。

## 常用命令

```bash
npx -y github:begin2019510/purchase-app-mcp status   # 查看登录状态、凭据路径
npx -y github:begin2019510/purchase-app-mcp logout   # 删除本机凭据并吊销服务端 refresh token
npx -y github:begin2019510/purchase-app-mcp login    # 重新登录
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `PURCHASE_APP_BASE_URL` | App 地址，默认 `https://121212121.top`；切换地址后需重新 `login` |
| `PURCHASE_APP_MCP_HOME` | 凭据/审计目录，默认 `~/.config/purchase-app-mcp`（或 `$XDG_CONFIG_HOME/purchase-app-mcp`） |
| `PURCHASE_APP_USERNAME` | 登录用户名，默认 `admin` |
| `PURCHASE_APP_PASSWORD` | 仅用于无浏览器环境的一次性登录；不保存 |

## 工具（27 个）

- 采购：`purchase.list` `purchase.get` `purchase.create` `purchase.update` `purchase.delete`
- 记账：`expense.list` `expense.create` `expense.update` `expense.delete`
- 待办：`todo.list` `todo.create` `todo.update` `todo.delete`
- 项目：`project.list` `project.get` `project.create` `project.update` `project.delete` `phase.list` `phase.status.set`
- 预算：`budget.get` `budget.save`
- 重复项 / 分类：`recurring.list` `recurring.update` `cats.list` `cats.update`
- 统计：`analytics.summary`（月度收入、采购、净支出、分期、预算使用率、分类 TOP、环比）

写操作全部走 App 真实业务 API，服务端的状态联动（审批、待办生成、分期、预算规则等）照常生效。

### 已知限制

当前 App 公网部署（Cloudflare Pages Functions）尚未暴露 `/api/phases`，因此 `phase.status.set` 会返回明确错误；`phase.list` 正常（读取 `/api/projects` 内嵌的阶段）。仓库内的 [`app-patch/functions/api/phases.js`](app-patch/functions/api/phases.js) 是缺失的一文件补丁：把它复制到 App 仓库的 `functions/api/phases.js` 并部署后，该工具即可用。

## 数据与隐私

本 MCP 不收集、不上传任何数据；所有请求直接从你的机器发往你自己的 App 地址（默认 `https://121212121.top`）。凭据与审计日志只保存在本机。

## License

MIT
