# purchase-app-mcp

把「个人管家」App 的**采购 / 记账 / 待办 / 项目 / 预算 / 统计**数据以 [MCP](https://modelcontextprotocol.io) 工具暴露给任意 agent（Claude Code、Cursor、IDE agent、自建 agent 均可）。

每个安装实例用自己的 App 账号登录，凭据只存本机；**仓库里没有任何硬编码 token / 密码 / 服务端密钥**。

## 给 agent：一次性安装链接（全自动，推荐）

App **v3.0.1+** 的「设置 → 连接 Agent（MCP）」可以生成一条形如 `https://<你的App>/agent#t=<票据>` 的链接。把链接交给 agent，它只需要运行：

```bash
npx -y github:begin2019510/purchase-app-mcp install "<链接>"
```

这一条命令会：

1. 注册 MCP 并安装 skill（等价于 `setup`）；
2. 用票据向 App 换取**该安装实例独立**的 refresh token；
3. 调用 `purchase.list` 做一次只读验证，成功时输出 `INSTALL_OK`。

链接 **10 分钟内有效、只能兑换一次**；生成新链接会让该账号之前未使用的链接立即失效。票据放在 URL 的 `#` 片段中，不会随请求出现在服务器日志或 Referer 里。

**全程不需要 App 密码**，agent 也不应索要密码。每个 agent 用各自生成的链接，就得到各自独立的凭据，可以单独 `logout` 吊销。

已登录的安装也可以为另一个 agent 生成链接：

```bash
npx -y github:begin2019510/purchase-app-mcp link
# 输出 JSON：{ "ok": true, "url": "...", "expiresAt": "...", "command": "..." }
```

给 agent 的完整安装/使用规则见 [AGENTS.md](AGENTS.md)。

## 给 agent：skill 链接（另一种方式）

把下面任一链接发给 agent：

- <https://github.com/begin2019510/purchase-app-mcp/blob/main/skills/purchase-app/SKILL.md>
- raw：`https://raw.githubusercontent.com/begin2019510/purchase-app-mcp/main/skills/purchase-app/SKILL.md`

agent 读取后会执行 `npx -y github:begin2019510/purchase-app-mcp setup`：自动注册 MCP、把 skill 安装到 `~/.claude/skills/purchase-app/`，然后引导用户完成一次登录。

> MCP 提供工具，skill 提供「安装 + 登录 + 验证 + 安全使用」步骤。skill 本身不接触密码或 token。

## 安全模型（如何保证受信）

| 保证 | 做法 |
|------|------|
| 必须鉴权 | 未登录时所有数据工具返回 401 类错误，必须先 `login` |
| 每安装独立凭据 | 每次登录换取独立的 refresh token（30 天，轮换），存本机 `auth.json`（0600） |
| 不共享写死 token | 代码与仓库中无任何 token；登录用 App 账号密码，密码**不落盘、不写日志** |
| 可单独吊销 | `logout` 删除本机凭据并吊销服务端该 refresh token，不影响其他安装 |
| 安装链接安全 | 票据 32 字节随机数，数据库只存 SHA-256；10 分钟有效、原子单次兑换；生成新链接即作废旧链接；票据只在 URL 片段中，不随请求上传 |
| 最小权限 | 只调用 App 已公开的业务 API；无用户管理、无部署/重启、无 shell、无数据库直连 |
| 传输安全 | 只接受 HTTPS App 地址（本机调试才允许 `http://127.0.0.1`）；登录页只监听 127.0.0.1 |
| 可审计 | 本机 `audit.log`（0600）记录每次工具调用，参数自动脱敏；App 侧另有操作日志 |

信任边界：安装了这个 MCP 且完成登录的 agent，拥有该 App 账号的数据读写权限。请只在自己信任的 agent 中配置；不再使用时执行 `logout`。

## 安装

要求：Node.js >= 18.17；安装时需要能访问 GitHub 和 npm registry（本机 npm 已配置 npmmirror 时更快）。MCP 只访问你自己的 App 地址，不依赖本仓库的服务器。

### 一键 setup（推荐）

```bash
npx -y github:begin2019510/purchase-app-mcp setup
```

- Claude Code：用官方 CLI 注册为用户级 MCP，并安装 skill；
- 已注册则跳过，幂等；
- 只写配置和 skill，不登录、不写凭据；
- 其他 agent / 只看配置：

```bash
npx -y github:begin2019510/purchase-app-mcp setup --print
```

输出纯 JSON（`mcpServers.purchase-app` + skill 路径/链接 + 命令），不写任何文件。也可以直接写指定的 JSON 配置：

```bash
npx -y github:begin2019510/purchase-app-mcp setup --agent json --config <配置文件路径>
```

每个 agent 独立凭据：加 `--home <独立目录>`，然后分别登录。

### Claude Code（手动）

```bash
claude mcp add purchase-app -s user \
  -e PURCHASE_APP_MCP_HOME=$HOME/.config/purchase-app-mcp \
  -- npx -y github:begin2019510/purchase-app-mcp
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

## 登录（有两条路，二选一）

- **有安装链接**：用上面的 `install "<链接>"`，不需要密码，也不需要本机浏览器。
- **本机登录**（没有链接时）：

```bash
npx -y github:begin2019510/purchase-app-mcp login
```

有图形界面（macOS、Windows、Linux 的 `DISPLAY`/`WAYLAND_DISPLAY`）时会自动打开浏览器；否则终端打印 `http://127.0.0.1:<port>/login/<一次性随机串>`，在浏览器打开并输入 App 账号（默认 `admin`）和密码。可用 `--no-open` 禁止自动打开。

- 密码只用于向 App 的 HTTPS 登录接口换取 token，**不会保存**。
- 只把 refresh token 写入 `~/.config/purchase-app-mcp/auth.json`（目录 0700、文件 0600）。
- access token 24 小时有效、自动续期；refresh token 30 天有效、每次续期轮换。
- 登录后无需重启 agent：MCP 进程会在下一次工具调用时自动读取新凭据。

**无浏览器的服务器**（推荐用安装链接，见文首；没有链接时二选一）：

```bash
# 方式 0（推荐）：让用户在 App 设置页生成一次性安装链接，然后
npx -y github:begin2019510/purchase-app-mcp install "<链接>"

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
npx -y github:begin2019510/purchase-app-mcp install "<链接>"  # 一次性链接：注册 + 授权 + 只读验证
npx -y github:begin2019510/purchase-app-mcp link              # 生成给别人用的一次性安装链接
npx -y github:begin2019510/purchase-app-mcp status            # 查看登录状态、凭据路径
npx -y github:begin2019510/purchase-app-mcp logout            # 删除本机凭据并吊销服务端 refresh token
npx -y github:begin2019510/purchase-app-mcp login             # 本机网页登录（有桌面自动开浏览器）
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `PURCHASE_APP_BASE_URL` | App 地址，默认 `https://121212121.top`；切换地址后需重新 `login` |
| `PURCHASE_APP_MCP_HOME` | 凭据/审计目录，默认 `~/.config/purchase-app-mcp`（或 `$XDG_CONFIG_HOME/purchase-app-mcp`） |
| `PURCHASE_APP_USERNAME` | 登录用户名，默认 `admin` |
| `PURCHASE_APP_PASSWORD` | 仅用于无浏览器环境的一次性登录；不保存 |

## 工具（46 个）

### 时间规则（v1.5.0 硬要求）

**记账 / 采购 / 待办的时间必须带时刻，一律用北京时间 `YYYY-MM-DDTHH:mm`。** 纯日期（如 `2026-11-20`）会被服务端存成当天 00:00，等于把用户说的时间抹掉；v1.5.0 起 MCP 直接拒绝纯日期并提示补时刻。

- 用户说「昨晚 7 点多」→ 先调 `time.parse({ text: '昨晚7点多' })` 得到 `2026-11-20T19:00`，再写入；不要自己心算。
- 只有日期没有时刻时，`time.parse` 返回 `needTime: true`，**必须先问用户几点**，禁止用 00:00 代替。
- 不确定「今天/现在」时先调 `time.now`（返回北京时间 ISO、星期、时区）。
- 项目截止日、跟踪记录里的日期字段可只到天，这类字段内部用 `allowDateOnly` 处理。

- 采购：`purchase.list` `purchase.get` `purchase.create` `purchase.update` `purchase.delete`
  `purchase.decide` `purchase.undecided` `purchase.cancel`
- 供应商：`supplier.add` `supplier.update` `supplier.delete`
- 子单：`order.transition` `order.update`
  - **读**（list/get）优先 `GET /api/needs`（需求/供应商/子单两级模型），返回 `needStatus`、`legacyStatus`、`orderStatus`、完整 `orders`/`suppliers`；旧部署自动回退 `/api/items`。
  - **写**：`compareOnly=true` 走原生 `POST /api/needs`；定点/供应商/子单走 `/api/needs|suppliers|orders`；`create/update/delete`（非 compareOnly）仍走 `/api/items` 兼容口，服务端状态机/Todo/分期联动照旧。
  - `status` 筛选同时接受：需求状态（对比中/已定点/已完成/已取消）、子单状态（待下单/已下单/…）、旧 8 态。
  - 列表统一**按日期倒序（最新在前）**，`limit=N` 恒为最新 N 条（v1.3.1：不依赖服务端返回方向，修复 needs 新→旧时截成最旧的问题）；`expense.list`/`todo.list` 的 `limit` 同语义。
- 记账：`expense.list` `expense.create` `expense.update` `expense.delete`
- 待办：`todo.list` `todo.create` `todo.update` `todo.delete`
- 项目：`project.list` `project.get` `project.create` `project.update` `project.delete` `phase.list` `phase.status.set`
  - `project.create` 支持两类项目：阶段计划（默认，可传 `steps` 一次拆成最多 6 步，每步可带 `name/budget/plannedDays`）与长期跟踪（`projectType: 'track'` + `trackFields` + `trackConfig`，至少要有 `goal.text`）。
  - `project.list/get` 返回 `projectType` 与阶段；跟踪项目额外返回目标进度、周目标、连续达标、里程碑、记录数等汇总。
- 跟踪项目（长期跟踪专用，v1.5.0 新增）：
  - 读：`tracker.records.list` `tracker.overview`
  - 写：`tracker.record.create` `tracker.record.update` `tracker.fields.update` `tracker.milestone.set` `tracker.reopen`
  - 高危（T1）：`tracker.record.delete`（confirm=记录标题）、`tracker.close`（confirm=项目名称）
- 时间：`time.now` `time.parse`（只读，用于把「昨晚 7 点多」解析成北京时间 ISO，写入前必用）
- 预算：`budget.get` `budget.save`
- 重复项 / 分类：`recurring.list` `recurring.update` `cats.list` `cats.update`
- 统计：`analytics.summary`（月度收入、采购、净支出、分期、预算使用率、分类 TOP、环比）；采购侧优先从 needs 全量子单聚合（与 App `orderRows` 同口径）

写操作全部走 App 真实业务 API，服务端的状态联动（审批、待办生成、分期、预算规则等）照常生效。

### 写操作分层（v1.4.0 起：T0 直接写 / T1 二次授权）

| 层 | 含义 | 工具 |
|----|------|------|
| **T0** | 用户一句话意图即可执行（创建、推进、代写优缺点等） | `purchase.create`（含 `compareOnly`）、`purchase.decide`、`supplier.add`、`supplier.update`、`order.transition` 正向（待下单→已下单→已到→已归档）、`order.update`、`expense.*` 增改、`todo.*` 增改与软删、`project.*` 增改、`budget.save`、`phase.status.set`、普通字段的 `purchase.update` |
| **T1** | 高危：必须先给用户一行预览（对象+后果+不可逆点），得到明确同意后带 `confirm` 调用 | `purchase.delete` / `purchase.cancel` / `purchase.undecided` / `purchase.update`（status 为已退/已取消/已归档）、`supplier.delete`、`order.transition` 进入已退/已取消/已归档、`project.delete`、`expense.delete`、`todo.delete(purge=true)`、`tracker.close`、`tracker.record.delete`、`cats.update`、`recurring.update` |

**`confirm` 规则**（MCP 在执行前先读目标真实名称再比对，不匹配直接报错、不执行）：

| 操作 | confirm 必须等于 |
|------|------------------|
| `purchase.delete` / `cancel` / `undecided` / 终态 `purchase.update` | 需求名称 |
| `supplier.delete` | 供应商名称 |
| `order.transition` → 已退/已取消/已归档 | **父需求名称** |
| `project.delete` | 项目名称 |
| `expense.delete` | 备注（无备注则 ID） |
| `todo.delete(purge=true)` | 待办标题 |
| `tracker.close` | 跟踪项目名称 |
| `tracker.record.delete` | 记录标题（无标题则日期或记录 ID） |
| `cats.update` / `recurring.update` | 固定字面量 `覆盖确认` |

诚实边界：MCP 无法真正验证「用户已点头」——与 GitHub 删除仓库同构：参数在工具调用中可见 + 本机 `audit.log` 留痕，作为标准折中。skill 铁律：T1 调用前必须先展示一行预览并得到用户明确回复。

**代写供应商优缺点（`supplier.add`/`supplier.update`）**：T0 直接写，但 skill 规定内容必须**以真实评价为基准**，且**每条优劣都要锚定价格**（到手价或同价位对比）；禁止无价格的通用套话与编造数据。详见 [SKILL.md](skills/purchase-app/SKILL.md)。

**综合推荐（`purchase.update` 的 `recommendation` + `recommendSupplierId`）**：T0 直接写。对比结论落需求级字段（服务端 `eval_summary` + `recommend_supplier_id`），App 详情页显示「💡 综合推荐」横幅并高亮推荐供应商；与优缺点同套铁律（点名供应商、锚定价格、真实评价），**推荐 ≠ 定点**（定点仍走 `purchase.decide`）。

### 阶段工具与版本要求

`phase.list` 与 `phase.status.set` 都走 App 公网 API。**App 3.0.0+**（2026-10 版本线重置；此前 4.0.52–4.0.61 同样包含）已部署 `/api/phases` 与 `/api/phase-items`，阶段状态/规划时间/交付物均可用。

如果调用返回「接口返回了网页而不是 JSON」，说明目标 App 的部署版本过旧（缺少阶段端点）；先升级 App。旧部署也可临时使用仓库内的 [`app-patch/functions/api/phases.js`](app-patch/functions/api/phases.js) 补丁，但不再推荐。

## 数据与隐私

本 MCP 不收集、不上传任何数据；所有请求直接从你的机器发往你自己的 App 地址（默认 `https://121212121.top`）。凭据与审计日志只保存在本机。

## License

MIT
