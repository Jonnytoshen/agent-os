# demo-server

> Agent OS 的「日志巡检」配套演示服务：
> 一个会写结构化 JSON 日志、并且可以按指令「弄坏自己」的迷你订单服务。

demo-server 是这套日志巡检链路里的**被巡检对象**。它不追求业务完整，只做两件事：

1. **稳定产出机器可读的日志**——每行一个 JSON 对象，字段固定，不用正则硬猜；
2. **故障可以按需注入**——一条 HTTP 请求或一个 npm script，就能制造出慢请求、5xx 尖峰、数据库不可用等现场。

于是「日志巡检」这件事被压缩成一个可控实验：
**你用命令决定日志里出现什么，再由 Agent 读出、分级、推送，并在必要时把活派给开发者。**

---

## 它解决什么问题

让 Agent 自动巡检线上日志，最常见的困难是**没有可复现的现场**：真实服务不会按你的节奏准时抛出 5xx，
而人工拼凑的日志又证明不了 Agent 真的在做判断——既不可复现，也覆盖不到分级、去重和派活这些分支。

demo-server 把这两件事分开解决：

| 问题                       | demo-server 的做法                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------ |
| 现场不可复现               | 故障模式由 `POST /__faults` 显式注入，同一场景每次跑出来都一样（`error-spike` 除外） |
| 日志无法可靠解析           | 结构化 JSON 行，异常信息落在 `level` / `statusCode` / `durationMs` / `errorCode`     |
| 无法验证「分级」和「去重」 | 五种故障模式分别对应 info / warning / critical 三档，覆盖全部判定分支                |
| 无法验证「派活」           | 配合 `scripts/notify.mjs --at developer`，critical 告警可以直接 @ 到开发者接手       |

换句话说：**demo-server 是给巡检 Agent 准备的靶场。** 它本身没有业务价值，订单数据是写死的三条。

---

## 快速开始

前置：Node 22+、pnpm。依赖已在 agent-os 仓库根安装完成（`demo-server` 是根仓库的 workspace 包，
见根目录 `pnpm-workspace.yaml`）。

### 1. 启动服务

```bash
# 在 agent-os 仓库根（推荐，根 package.json 有转发脚本）
pnpm demo:server

# 或者进目录直接跑
cd demo-server
pnpm start
# 等价于 tsx src/server.ts
```

启动后输出：

```
[demo-server] 已启动 http://localhost:3222
[demo-server] 日志文件 /absolute/path/to/demo-server/logs/app.log
```

### 2. 生成流量

另开一个终端：

```bash
pnpm demo:traffic              # 默认 normal 场景
pnpm demo:traffic slow         # 也可以直接跟场景名

# 等价写法
cd demo-server && pnpm traffic --scenario repeated-error
```

流量脚本会先把服务切到对应故障模式，再按固定序列打 20 次请求（`slow` 场景 5 次），最后告诉你日志在哪：

```
[demo-server] 故障模式：repeated-error
[demo-server] 流量已生成，巡检内容在日志文件里：
  demo-server/logs/app.log
```

### 3. 看日志

```bash
tail -n 50 demo-server/logs/app.log
```

### 4. 手工注入故障（不用脚本）

```bash
curl -s -X POST localhost:3222/__faults -H 'content-type: application/json' -d '{"mode":"repeated-error"}'
curl -s -o /dev/null -w '%{http_code}\n' localhost:3222/api/orders/1   # 500
curl -s -o /dev/null -w '%{http_code}\n' localhost:3222/api/orders/3   # 200
curl -s -X POST localhost:3222/__faults -H 'content-type: application/json' -d '{"mode":"none"}'  # 复位
```

> ⚠️ **记得复位。** 故障模式是进程内的全局状态，注入后不会自己消失。
> 忘了复位，`/api/orders/1` 会一直返回 500，而巡检 Agent 每个去重窗口都会重新告警一次。

---

## HTTP 接口

| 方法   | 路径              | 说明                     | 响应                                               |
| ------ | ----------------- | ------------------------ | -------------------------------------------------- |
| `GET`  | `/health`         | 健康检查                 | `200` `{"status":"ok"}`                            |
| `GET`  | `/api/orders`     | 订单列表（3 条写死数据） | `200` `{"orders":[{"id","customer","amount"}...]}` |
| `GET`  | `/api/orders/:id` | 订单详情                 | `200` `{"order":{...}}`；查不到时 `{"order":null}` |
| `GET`  | `/__faults`       | 查询当前故障模式         | `200` `{"mode":"none"}`                            |
| `POST` | `/__faults`       | 切换故障模式             | `200` `{"mode":"<新值>"}`；非法值 `500`            |
| `*`    | 其它路径          | 未知路由                 | `404` `{"error":"接口不存在"}`                     |

写死的订单数据：

| id  | customer | amount |
| --- | -------- | ------ |
| `1` | 林一     | 128    |
| `2` | 陈晓     | 86     |
| `3` | 周舟     | 399    |

### 两个容易踩的细节

- **列表接口 `/api/orders` 不受任何故障模式影响。** 它既不调用 `faults.get()`，`applyFaultDelay()` 也是空参调用。
  要观察故障，必须打**详情**接口 `/api/orders/:id`。
- **详情接口查不到 id 时返回 `200` + `{"order":null}`，不是 404。** 所以「日志里没有 404」不等于数据正常，
  巡检时必须结合 `statusCode` 和 `errorCode` 一起看。

---

## 故障模式

`FaultStore` 维护一个进程内全局模式，取值只能是下面五种（其它值一律拒绝，返回 500 且**不改变当前模式**）：

| 模式             | 触发条件                             | 表现                                               | 日志级别 / errorCode             |
| ---------------- | ------------------------------------ | -------------------------------------------------- | -------------------------------- |
| `none`           | —                                    | 一切正常                                           | `info`                           |
| `slow`           | 所有 `/api/orders/:id`               | 延迟 1200ms 后正常返回 `200`                       | `warn` / `SLOW_REQUEST`          |
| `error-spike`    | 所有 `/api/orders/:id`，**30% 概率** | `500` `{"error":"订单服务内部错误"}`               | `error` / `ORDER_FETCH_FAILED`   |
| `repeated-error` | **仅** `/api/orders/1`               | `500` `{"error":"订单服务超时"}`（`/2` `/3` 正常） | `error` / `DB_TIMEOUT`           |
| `db-down`        | 所有 `/api/orders/:id`               | `503` `{"error":"数据库连接失败"}`                 | `error` / `DB_CONNECTION_FAILED` |

这五种模式覆盖了巡检的三档判定：

- `none` / 正常请求 → **info，保持静默**；
- `slow` → 状态码是 200 但耗时超标，对应「**不能只看状态码**」这一条；
- `error-spike` → 偶发、可恢复的单点错误，按 **warning** 只推送不派活；
- `repeated-error` → 同一路径连续 100% 失败，按 **critical** 推送并 @ 开发者；
- `db-down` → 依赖整体不可用，同样 **critical**，但错误码不同，可用于验证去重指纹的区分度。

`/health` 和 `/__faults` 自身永远不受故障模式影响——否则你就没法在服务「坏了」的时候把它救回来了。

### 生存期与复位

故障模式是**进程内的全局状态**：不落盘、没有 TTL，也没有任何兜底逻辑会主动复位它。

- `FaultStore` 由 `src/server.ts` 在启动时新建，初值为 `none`，所以**重启进程即可清除**当前模式。
- `src/traffic.ts` 注入模式、打完请求后直接退出，**不复位**；`FaultStore.reset()`（`src/faults.ts:20`）
  虽然存在，但在整个仓库里没有任何调用点。
- 因此 `repeated-error` / `db-down` 一旦注入就会持续生效，`/api/orders/1` 会一直返回 5xx，
  直到显式切回 `none` 或重启进程。

```bash
# 复位
curl -s -X POST localhost:3222/__faults -H 'content-type: application/json' -d '{"mode":"none"}'
```

对巡检的影响：泄漏的模式会让同一批错误在每个 60 分钟去重窗口结束时被重新判定为 critical，
同一个根因被反复 @ 派活，直到有人复位。

---

## 日志格式

日志文件：`logs/app.log`，**每行一个 JSON 对象**，同步追加（`appendFileSync`），目录不存在会自动创建。
路径由 `DEMO_SERVER_LOG_FILE` 覆盖。

| 字段         | 类型    | 说明                                                        |
| ------------ | ------- | ----------------------------------------------------------- |
| `time`       | string  | ISO 8601 UTC 时间戳（判断时间以它为准，不要用当前时间代替） |
| `service`    | string  | 固定 `demo-server`                                          |
| `requestId`  | string  | 12 位十六进制，每次请求唯一，用于把一次请求的日志串起来     |
| `level`      | string  | `info` \| `warn` \| `error`                                 |
| `message`    | string  | 人类可读的中文摘要                                          |
| `method`     | string  | HTTP 方法                                                   |
| `path`       | string  | 请求路径                                                    |
| `statusCode` | number  | HTTP 状态码                                                 |
| `durationMs` | number  | 处理耗时（毫秒）                                            |
| `errorCode`  | string? | 机器可读错误码，**去重指纹的主要成分**，正常请求不出现      |
| `mode`       | string? | 仅 `POST /__faults` 的记录里出现，表示切换后的模式          |

### 日志样例

```json
{"time":"2026-09-18T02:52:29.370Z","service":"demo-server","requestId":"7a3f3d927067","level":"info","message":"订单读取成功","method":"GET","path":"/api/orders/1","statusCode":200,"durationMs":0}
{"time":"2026-09-18T02:01:28.501Z","service":"demo-server","requestId":"360b02fe73e4","level":"warn","message":"慢请求：读取订单耗时过长","method":"GET","path":"/api/orders/2","statusCode":200,"durationMs":1202,"errorCode":"SLOW_REQUEST"}
{"time":"2026-09-18T01:15:47.819Z","service":"demo-server","requestId":"86a9e0de4117","level":"error","message":"读取订单超时","method":"GET","path":"/api/orders/1","statusCode":500,"durationMs":0,"errorCode":"DB_TIMEOUT"}
{"time":"2026-09-18T02:33:09.169Z","service":"demo-server","requestId":"fe44ae0c128d","level":"info","message":"故障模式已切换","method":"POST","path":"/__faults","statusCode":200,"durationMs":1,"mode":"repeated-error"}
```

四行都是 `logs/app.log` 里的真实记录，可以直接 `grep` 到（例如 `grep SLOW_REQUEST logs/app.log`）。

### 服务端在什么情况下写 warn / error

| 场景                                                | level   | message / errorCode                                     |
| --------------------------------------------------- | ------- | ------------------------------------------------------- |
| 订单接口成功，`durationMs < 1000`                   | `info`  | `订单读取成功` / `订单列表读取成功`                     |
| 订单接口成功，`durationMs >= 1000`                  | `warn`  | `慢请求：读取订单耗时过长` / `SLOW_REQUEST`             |
| 未知路由                                            | `warn`  | `未知路由`（无 errorCode）                              |
| 数据库不可用                                        | `error` | `数据库连接失败，无法读取订单` / `DB_CONNECTION_FAILED` |
| 连续重复的订单读取失败                              | `error` | `读取订单超时` / `DB_TIMEOUT`                           |
| 随机订单读取失败                                    | `error` | `读取订单失败` / `ORDER_FETCH_FAILED`                   |
| 请求处理抛异常（如 `POST /__faults` 传了非法 mode） | `error` | `服务内部错误` / `INTERNAL_ERROR`                       |

> 注意：**慢请求阈值是 `durationMs >= 1000`，但即使状态码是 200 也算异常。**
> 这是巡检中最容易被忽略的一条——只看 5xx 会漏掉整类性能劣化。

---

## 巡检是怎么工作的

巡检逻辑本身**不在 demo-server 里**，也不在 Agent OS 的代码里，而是写在服务项目自己的手册里：

```
demo-server/.agents/skills/log-patrol/SKILL.md
```

> 手册由服务项目维护，Agent OS 只负责到点叫醒你。

这是这套设计里最关键的一条边界：**巡检标准应该跟着服务走，而不是跟着调度平台走。**
换一个服务，换一份手册，调度侧不需要改任何代码。

### 一轮巡检的完整流程

| 步骤      | 做什么                                                                                    | 状态文件                        |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| 1. 读游标 | 读上次检查到第几行                                                                        | `.scratch/patrol-cursor.json`   |
| 2. 增量读 | 只看游标之后的新行（`tail` / `grep` / `awk`），日志变短或不存在则游标归零                 | —                               |
| 3. 理解   | 按 JSON 行解析；**非 JSON 行不丢弃**，按原始文本尽力提取错误码和时间                      | —                               |
| 4. 分级   | 按下面那张表判定 info / warning / critical                                                | —                               |
| 5. 去重   | 用 `errorCode + service + message 模板` 做指纹，60 分钟内不重复推送、不重复派活           | `.scratch/patrol-alerts.json`   |
| 6. 通知   | 全部发现**合并成一条**消息，先列 critical 再列 warning；有 critical 才加 `--at developer` | —                               |
| 7. 记录   | 写清检查窗口、状态、findings；一切正常时**不发消息**，只更新记录                          | `.scratch/patrol-last-run.json` |
| 8. 回写   | 把最后检查的行号写回游标                                                                  | `.scratch/patrol-cursor.json`   |

### 分级标准

| 日志情况                                                    | 判定         | 处置                      |
| ----------------------------------------------------------- | ------------ | ------------------------- |
| `level=info` 的正常请求                                     | 不构成异常   | 静默                      |
| 单条 `warn`                                                 | 不报         | 静默                      |
| 同一原因大量 `warn`，或响应明显变慢（`durationMs >= 1000`） | **warning**  | 推送运维群，**不派活**    |
| 偶发且可恢复的单点 `error`                                  | **warning**  | 推送运维群，**不派活**    |
| 连续重复错误 / 影响多个请求 / 5xx 明显上升 / 数据库连接失败 | **critical** | 推送运维群并 **@ 开发者** |

### 去重指纹

指纹格式是 `errorCode|service|message 模板`，**不能带 `requestId`、`time` 这类每次都变的内容**，
否则每次都会算成新告警，去重形同虚设。真实例子：

```
ORDER_FETCH_FAILED|demo-server|读取订单失败
DB_TIMEOUT|demo-server|读取订单超时
SLOW_REQUEST|demo-server|慢请求：读取订单耗时过长
```

60 分钟窗口过期后，同一指纹会**重新评估并恢复推送**——这正是复盘中「同一根因反复派活」的成因。

### @ 即派活

推送用的是 `scripts/notify.mjs`，它读根目录 `.env` 里的 `PATROL_WEBHOOK_URL`：

```bash
# 仅推送（warning 场景，不带 --at）
node scripts/notify.mjs --text "【warning】demo-server 出现 4 条慢请求 ..."

# 推送并 @ 开发者（存在 critical 时）
node scripts/notify.mjs --at developer --text "【critical】demo-server /api/orders/1 连续 5 次 500 ..."
```

`--at developer` 会去读 `data/bot-identities.json`，把 bot id 换成飞书 `open_id` 再塞进消息体：

```json
{
  "msg_type": "text",
  "content": { "text": "<at user_id=\"ou_1846...\">@developer</at> 【critical】..." }
}
```

**@ 到开发者就等于派活。** 手册里写得很明确：巡检 Agent 不要自己修代码，也不要重复推送——
它负责发现和转交，修复是开发者的活。

---

## 接上 Agent OS 定时巡检

调度配置在仓库根的 `data/schedules.json`。当前生效的这一条：

```json
{
  "id": "e6470039aa48",
  "targetBotId": "developer",
  "chatId": "oc_a7fd4a19bbf50c0d5834789c0307d0ba",
  "rule": { "kind": "interval", "everyMs": 7200000 },
  "status": "active"
}
```

| 字段          | 含义                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `targetBotId` | 由哪个 bot 执行——`developer`，即开发工程师角色                                         |
| `chatId`      | 巡检话题所在的飞书群（运维群）                                                         |
| `rule`        | 调度规则。`interval` 每 2 小时一次；也支持 `once`（`runAt`）和 `cron`（表达式 + 时区） |
| `prompt`      | 巡检指令，见下                                                                         |

`rule.kind=interval` 的 `everyMs` 取值范围是 **60,000 ~ 86,400,000**（1 分钟 ~ 24 小时）。

`prompt` 是巡检真正的「指挥」部分，它把手册、工作目录、增量游标、分级、去重、记录六件事一次性交代清楚：

```
你是 demo-server 的值班巡检 Agent，本次为定时触发的服务端日志巡检。

项目目录（绝对路径）：/.../agent-os/demo-server
巡检手册：/.../agent-os/demo-server/.agents/skills/log-patrol/SKILL.md

执行要求：
1. 先完整读取巡检手册 SKILL.md，严格按手册流程执行本轮巡检，不要自行发明流程。
2. 所有命令先 cd /.../agent-os/demo-server 再执行；日志、脚本、状态文件都以该目录为基准。
3. 读取 .scratch/patrol-cursor.json 的游标做增量检查，只分析游标之后的新增日志行……
4. 按手册标准分级（info / warning / critical），重点关注：慢请求、5xx 上升、连续重复错误、数据库连接失败。
5. 需要推送时按手册执行 node scripts/notify.mjs，本轮所有发现合并成一条消息……
6. 遵守 .scratch/patrol-alerts.json 的 60 分钟去重窗口……
7. 巡检记录写入 .scratch/patrol-last-run.json……
8. 不要修改或删除日志文件；不要自己改代码修复，需要修复时 @ developer 接手。
```

两个值得注意的约定：

- **prompt 里必须带绝对路径。** 定时任务被唤醒时没有「当前目录」这回事，路径写死才能保证日志、脚本、
  状态文件都落在同一个基准上。
- **prompt 只做转交，不做判断。** 具体阈值（1000ms、60 分钟、什么算 critical）全部留在 SKILL.md 里，
  改阈值不用动调度配置。

另外，`config/bots.json` 里三个 bot（`ceo-assistant` / `product` / `developer`）的 `workspace`
都是 `./demo-server`——**这个目录同时也是 Agent 的工作目录**。所以巡检里那句 `cd demo-server`
不是「跨目录访问别的项目」，而是回到自己的工作区。

---

## 一次真实巡检的复盘

`logs/app.log` 里留着一次完整巡检的痕迹（189 行：149 条 info、36 条 error、4 条 warn）。
把它当作这套机制的压力测试结果来读：

**故障注入史（9 次模式切换）：**

| 时间                    | mode                | 说明                       |
| ----------------------- | ------------------- | -------------------------- |
| `01:15:38`              | `error-spike`       | traffic 跑场景，**没复位** |
| `01:15:47`              | `repeated-error`    | traffic 跑场景，**没复位** |
| `02:00:00`              | `none`              | 人工复位                   |
| `02:01:27`              | `slow`              | 再次注入                   |
| `02:02:19` ~ `02:33:09` | `repeated-error` ×4 | 被反复注入 4 次            |
| `02:34:07`              | `none`              | 开发者现场处置，进程未重启 |

**巡检侧的产出：**

- `01:15` 窗口：13 条 5xx（`ORDER_FETCH_FAILED` ×8 + `DB_TIMEOUT` ×5），按 critical 推送并 @ developer；
- `02:02` / `02:07` / `02:13`：同一指纹在 60 分钟去重窗口内，**被正确抑制**（`suppressed`，不重复派活）；
- `02:33`：窗口过期，`DB_TIMEOUT` 再次达到 critical 门槛，**恢复推送并 @ developer**。

**根因（由被 @ 的开发者定位，巡检 Agent 不介入修复）：**

1. `src/traffic.ts` 注入故障模式后跑完请求直接退出，**从不复位**；
2. `src/faults.ts` 里有 `reset()`，但**全仓库没有任何调用点**——是死代码；
3. 于是 `repeated-error` 一旦注入，`/api/orders/1` 就**永久** 100% 返回 500，
   而 60 分钟去重窗口一过，巡检就会把同一件事再派一次活。

这个案例恰好说明了两件事的好处：**结构化日志让根因可被精确回溯**（谁在什么时候注入了什么模式、
哪个路径 100% 失败），而**「@ 即派活」把发现和修复分给了两个角色**——巡检不做它不该做的事。

---

## 目录结构

```
demo-server/
├── src/
│   ├── server.ts                    # HTTP 服务：路由 + 故障分支 + 日志埋点
│   ├── faults.ts                    # FaultStore：故障模式状态机
│   ├── logger.ts                    # JsonFileLogger：结构化 JSON 行日志
│   └── traffic.ts                   # 流量生成脚本（注入模式 + 打 20 次请求）
├── scripts/
│   └── notify.mjs                   # 飞书运维群推送，支持 --at <botId>
├── .agents/skills/log-patrol/
│   └── SKILL.md                     # 巡检手册：分级、去重、通知、记录的全部标准
├── logs/
│   └── app.log                      # 运行日志（gitignore）
├── .scratch/                        # 巡检状态 + 事故/修复记录 + 验证脚本（gitignore）
├── dist/                            # tsc 构建产物（gitignore）
├── package.json
├── tsconfig.json
└── .gitignore
```

`package.json` 里的三个脚本：

| script    | 命令                 | 用途                      |
| --------- | -------------------- | ------------------------- |
| `start`   | `tsx src/server.ts`  | 启动服务                  |
| `traffic` | `tsx src/traffic.ts` | 生成流量（可跟场景名）    |
| `build`   | `tsc`                | 类型检查 + 输出到 `dist/` |

---

## 环境变量

服务端（`src/server.ts`）：

| 变量                   | 默认值         | 说明                     |
| ---------------------- | -------------- | ------------------------ |
| `DEMO_SERVER_PORT`     | `3222`         | 监听端口                 |
| `DEMO_SERVER_LOG_FILE` | `logs/app.log` | 日志文件路径（相对 cwd） |

流量脚本（`src/traffic.ts`）：

| 变量                   | 默认值                  | 说明         |
| ---------------------- | ----------------------- | ------------ |
| `DEMO_SERVER_BASE_URL` | `http://localhost:3222` | 目标服务地址 |

推送脚本（`scripts/notify.mjs`）：

| 变量                 | 来源          | 说明                                                  |
| -------------------- | ------------- | ----------------------------------------------------- |
| `PATROL_WEBHOOK_URL` | 仓库根 `.env` | 飞书自定义机器人 webhook；未配置时退出码 1 并跳过推送 |

`scripts/notify.mjs` 会从脚本所在位置向上两级读取 `agent-os/.env`，所以**凭证统一放在仓库根的 `.env`**
（已在 `.gitignore` 中），demo-server 自己不需要额外配置文件。
