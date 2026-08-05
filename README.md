# AI 员工

基于 DWS、Codex 和 PostgreSQL 的钉钉 AI 员工。它实时发现白名单联系人的新消息，合并连续消息，判断是否需要回复，生成草稿，并在逐任务审批后受控发送。

生产默认是“草稿模式”：可以监听、判断和生成草稿，不能自行外发。开启发送仍必须同时满足能力开关、人工审批、发送前人工回复复查和幂等账本。

## 已实现能力

| 能力 | 生产状态 | 边界 |
|---|---|---|
| 钉钉消息监听 | 可用 | 只读取白名单单聊和白名单群中的 `@我` 消息 |
| 实时唤醒与补漏 | 可用 | 本地活动信号唤醒，5 分钟增量检查兜底 |
| 消息与任务可靠性 | 可用 | PostgreSQL 去重、事务、租约、重试和死信 |
| 连续消息合并 | 可用 | 默认安静 3 秒；相隔超过 2 分钟或超过 20 条会拆分任务 |
| 判断是否回复 | 可用 | 明确闭环走硬规则，其余由 Codex 结合上下文复核 |
| 影子质量评估 | 可用 | 逐任务人工标注与不可变历史；至少 100 条、分层覆盖达标、“不回复准确率”达到 95% 且高风险错误回复建议为 0 才通过 |
| 草稿生成 | 可用 | 独立 Worker、只读 Codex 沙箱 |
| 人工审批与发送 | 可用、默认关闭 | 每条消息单次批准；未知结果不自动重发 |
| 健康与指标 | 可用 | 进程心跳、真实 DWS 读取检查点、24 小时 SLO、管理台运营视图和 Prometheus 指标 |
| 本机管理台 | 可用 | 总览、草稿、计划、局部暂停、记忆与健康；读写令牌分离，不提供执行和发送入口 |
| 异常告警 | 可用、默认仅本机 | 脱敏状态、签名 Webhook 和 15 分钟冷却；未配置网址时不对外发送 |
| 常驻与恢复 | 可用 | macOS LaunchAgent、独立消息源对账、数据库迁移、加密备份和恢复 |
| 项目能力与任务计划 | 可用 | 项目清单、完整计划风险、审批哈希和默认拒绝 |
| 钉钉工作请求转计划 | 可用、默认只提案 | 明确工作请求只在请求人授权项目中起草计划；不自动执行 |
| 常驻计划执行器 | 可用、默认关闭 | 仅在全局执行开关开启后领取已授权计划；持续租约，崩溃后停止且不重放副作用 |
| 任务级取消 | 可用 | 未执行计划立即取消；只读 Codex 和本地测试可确认中断进程组；外部副作用步骤完成回读或回滚后停止后续步骤 |
| 死亡任务处置 | 可用、需负责人操作 | 可选择重试或审计关闭；关闭不会生成草稿、发送消息或再次调用 Codex |
| 项目结果回传 | 可用 | 完成、失败或取消后在原会话生成幂等的待审批结果草稿，不直接发送 |
| 正式记忆 | 可用 | 来源、范围、人工确认、过期、撤销、冲突替代门禁和字段级加密 |
| gbrain 知识页读取 | 可用、默认关闭 | 只读取项目白名单前缀内的精确 slug；限页数、限正文，后续步骤必须显式引用 |
| 研究、文档与代码补丁 | 可用 | 只读 Codex；补丁先通过 `git apply --check` |
| 隔离修改与本地测试 | 可用、按项目授权 | 补丁只进入独立 worktree 和分支；测试仅运行清单登记的精确命令 |
| Git 推送 | 可用、强制审批 | 只推 `ai-employee/` 前缀分支，远端 URL 固定，推后回读提交哈希 |
| 生产发布 | 可用、L4 强审批 | 发布、验收、回滚命令同时绑定计划；失败自动回滚并复验 |
| 共享文档创建 | 可用、强制审批 | 只写项目固定文件夹或知识库，创建后 DWS 回读内容哈希 |
| 钉钉待办创建 | 可用、强制审批 | 执行人和优先级由项目清单固定，创建后按任务 ID 回读 |
| 钉钉日程创建 | 可用、强制审批 | 固定参与人与时长；会议室按白名单名称实时搜索唯一 ID；循环仅限有次数上限的按日/按周规则，创建后回读 |
| 钉钉日志提交 | 可用、强制审批 | 固定模板编号、名称和完整字段结构；提交前核对模板漂移，提交后按日志 ID 回读 |
| OA 审批决策 | 禁止自动执行 | 可以读取并整理待审批信息；同意、拒绝和转交必须由负责人本人操作 |
| 生产数据修改 | 仅登记、无适配器 | 不允许通用执行，必须按具体系统另建能力和回滚方案 |

这些限制是能力边界，不是故障：消息里的文字不能自行扩大 AI 权限。gbrain、待办、日程、日志、共享文档、代码、测试、推送和发布只有在项目清单显式登记知识路径、人员、模板、目标、目录、精确命令、远端、审批、验收和回滚后才能执行；示例清单本身不构成任何真实项目授权。

计划执行还受独立的全局开关 `work_plan_execution` 控制。项目清单授权、计划审批和全局执行开关三者缺一不可。影子模式强制要求该开关关闭。

项目复用与正式记忆的简明说明见[能力清单与正式记忆](./docs/能力清单与正式记忆.md)。

新项目先生成安全默认配置草案。默认只自动开放研究和文档草稿，代码补丁与隔离分支需要审批，gbrain、测试、待办、日程、日志、共享文档、推送和发布保持禁用：

```bash
npm run projects:create -- \
  --project-id example_project \
  --name "示例项目" \
  --root /absolute/path/to/project \
  --requester replace_with_dingtalk_user_id
```

审查输出后，显式增加 `--write` 才会以 `600` 权限写入项目目录。后续按项目补充 gbrain slug 前缀、待办执行人、日程参与人、固定文档目标、精确测试命令、Git 远端和发布三联命令，再运行 `npm run projects:validate`。项目创建脚本不会自动授予这些能力。

## 生产要求

- macOS，已登录钉钉桌面端。
- Node.js 22.5 或更高版本。
- DWS、Codex CLI、gbrain、`pg_dump` 和 `pg_restore`。默认从 `PATH` 查找 Codex 与 gbrain，也可以用 `CODEX_PATH`、`GBRAIN_PATH` 固定路径。gbrain 能力在新项目中默认关闭。
- PostgreSQL 16 或 17。
- DWS 和 Codex 的有效本机授权。

## 首次部署

1. 安装依赖：

```bash
npm ci
```

2. 创建 PostgreSQL。仓库提供了只监听本机端口的 Compose 配置：

```bash
mkdir -p .runtime/secrets
openssl rand -hex 32 > .runtime/secrets/postgres_password
chmod 600 .runtime/secrets/postgres_password
docker compose -f deploy/postgres.compose.yml up -d
```

3. 初始化生产配置。脚本会生成相互独立的数据密钥、备份密钥和管理令牌，以 `600` 权限创建文件，且绝不覆盖已有配置：

```bash
npm run config:init
```

已有环境需要轮换管理台令牌时，使用原子轮换命令。它先生成 `600` 权限配置快照，再写入两枚独立新令牌，输出中不包含令牌值：

```bash
npm run config:rotate-admin -- --yes
```

然后编辑 `.runtime/production.json` 中列出的占位项：数据库连接、租户编号、监听对象、自身用户编号和操作人编号。也可以从[生产配置示例](./deploy/生产配置.example.json)手工创建，但数据密钥和备份密钥必须分别生成，不能相同：

```bash
openssl rand -base64 32
openssl rand -base64 32
```

生产配置中的密钥字段也支持外部引用，参考[外部密钥生产配置示例](./deploy/外部密钥生产配置.example.json)：

- `env://变量名`：适合 CI、容器或由进程管理器注入的环境变量。
- `keychain://服务名/账号名`：适合 macOS 登录钥匙串。

引用只允许用于已登记密钥字段。任一密钥不存在、格式错误或钥匙串不可用时，整份配置都不会注入，服务直接停止；不会回退到明文或占位值。外部托管的管理令牌必须在原密钥库轮换，配置文件轮换命令会拒绝覆盖。

使用仓库内的 GitHub 人工生产发布工作流时，应从[GitHub 生产配置示例](./deploy/GitHub生产配置.example.json)开始，5 项生产密钥统一引用 macOS 钥匙串；工作流拒绝包含这 5 项明文或临时环境变量引用的配置。

macOS 上可先预览再迁移固定的 5 项生产密钥；命令会保留受保护的回滚快照，逐项回读成功后才替换配置：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run config:migrate-keychain

AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run config:migrate-keychain -- --apply
```

4. 先运行只读生产诊断。它检查配置、密钥、远程数据库 TLS、所需工具、Codex 登录与网络运行状态、项目能力清单和数据库连接，但不修改数据库：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run production:doctor
```

`production:preflight` 保留为相同的只读生产预检入口。首次部署或升级草稿 Schema 后，诊断通过还应人工运行一次合成草稿探针。它会调用一次 Codex，只使用固定测试消息，不读取钉钉或数据库，也不展示和保存回复内容：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run production:codex-probe
```

探针通过后，再显式执行数据库迁移：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run db:migrate
```

5. 安装并启动监听、Worker、默认休眠的计划执行器、健康检查、本机管理台、异常监测和每日备份：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run service:install
```

6. 验证所有依赖和组件心跳：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run production:verify
```

真实发送保持关闭时，还可以执行只读影子验收。它会检查健康、异常任务、执行中的计划和发送能力，不会运行 Codex 或修改数据库：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
npm run shadow:verify
```

在管理台“判断质量”中可以直接处理优先人工复核队列，并按私聊/群聊、联系人或群、判断来源查看误判；“消息草稿”仍支持逐条标注。优先队列用于先发现高风险问题，不能替代覆盖性抽样。也可以使用命令行：

```bash
npm run control -- review-label <任务编号> reply
npm run control -- review-label <任务编号> no-reply
npm run quality:report
```

没有足够人工标注、分层覆盖不足或标签已因判断变化而失效时，影子验收会明确失败，不能用进程健康、单一类型样本或 AI 自评代替人工判断质量。

恢复演练使用随机命名的隔离数据库，验证后自动删除隔离库，不覆盖生产库：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run db:restore:drill
```

完整部署、升级、回滚、备份和恢复方法见[生产运维手册](./docs/生产运维手册.md)。

## 日常操作

以下命令都使用同一份生产配置：

```bash
export AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json"
```

查看任务：

```bash
npm run control -- list
npm run control -- list awaiting_approval
npm run control -- show <任务ID>
```

更新监听白名单（只显示数量，不输出联系人 ID）：

```bash
# 先预览；省略的范围保持不变
npm run targets:update -- --users "用户ID1,用户ID2" --dry-run

# 正式更新；空字符串可明确清空群聊白名单
npm run targets:update -- --users "用户ID1,用户ID2" --groups ""
```

更新配置后执行 `npm run service:install` 让常驻服务重新加载。

批准、拒绝或重试：

```bash
npm run control -- approve <任务ID> "同意发送"
npm run control -- reject <任务ID> "改为人工回复"
npm run control -- retry <任务ID>
```

修订工作计划时，先用 `plan-show` 导出旧计划，修改目标或步骤后通过标准输入提交。旧计划只允许在“待审批”或“已拒绝”状态修订；成功后立即变为“已替代”，新计划获得新编号和新哈希，并强制重新审批：

```bash
npm run control -- plan-show <旧计划ID>
npm run control -- plan-revise <旧计划ID> <项目能力清单路径> < 修订后的计划.json
```

也可以在本机管理台点击“修订”，编辑目标和完整步骤。计划来源、请求人和项目不能被修改；已经批准或开始执行的计划必须先按取消流程处理，不能原地改写。

暂停和恢复：

```bash
npm run control -- pause
npm run control -- resume
npm run control -- scope-pause contact <联系人账号> <原因>
npm run control -- scope-pause project <项目编号> <原因>
npm run control -- scope-pause capability <能力名称> <原因>
npm run control -- scope-list
npm run control -- scope-resume <contact|project|capability> <对象>
```

联系人暂停会延后草稿生成和已批准发送且不消耗重试次数；项目暂停会阻止新计划提案和领取；能力暂停会阻止包含该能力的计划开始。执行中的计划在当前外部副作用安全验收后停在下一步，恢复后继续，不自动重放已经发生的动作。

管理台“人工接管”会把计划转换为可操作状态：可安全请求中断、正在请求中断、外部动作安全收尾、已确认中断、租约过期需核对。只有出现 `operator_interrupt_confirmed` 证据时才显示“已确认中断”；外部副作用没有确认前禁止重复执行或直接重试。

发送结果未知时必须先人工核对钉钉：

```bash
# 已经发出
npm run control -- resolve-sent <任务ID>

# 确认没有发出，允许继续使用原幂等键
npm run control -- resolve-not-sent <任务ID>
```

健康检查和指标：

```bash
npm run health
curl http://127.0.0.1:9464/live
curl http://127.0.0.1:9464/ready
curl http://127.0.0.1:9464/metrics
```

管理台“运营指标”和 `/metrics` 使用最近 24 小时真实记录计算消息发现、真实漏检、任务和副作用指标，并使用分钟采样计算滚动 30 天入口可用性。入口同一分钟任一次异常或整分钟缺测都计为不可用，未积满 30 天只展示观察值，不能宣称达到 99.5%。独立对账每小时比较消息源与数据库，自动回补本地漏项且不发送钉钉消息；报告只保存数量、比例和时间窗。成功率、草稿产出、全流程和审批分别展示各自样本数；无样本明确显示未知。单次窗口超过 10,000 条时标记数据不完整，不能据此声称 SLO 达标。`/ready` 不执行需要解密任务的统计查询，但可将消息源对账作为生产门禁。

本机管理台默认位于 `http://127.0.0.1:9465`。进入后输入生产配置里的只读令牌；需要暂停、审批、修订或撤销时再输入另一枚写入令牌。令牌仅保存在当前浏览器标签页的 `sessionStorage`，管理台固定只监听回环地址。草稿审批会展示实际回复、风险与原因，并绑定草稿哈希；计划审批会展示全部步骤、输入、验收和回滚，L3/L4 还需输入计划哈希末 8 位。内容变化后旧页面不能继续批准，必须刷新重审。

需要把异常发送到外部值班系统时，额外配置 HTTPS Webhook 和独立签名密钥：

```json
{
  "AI_EMPLOYEE_ALERT_WEBHOOK_URL": "https://monitor.example/ai-employee",
  "AI_EMPLOYEE_ALERT_WEBHOOK_SECRET": "至少 32 字节的独立随机密钥"
}
```

Webhook 只包含健康状态码、时间和队列计数，不包含联系人、消息、草稿、任务 ID、数据库地址或项目内容。未配置网址时只写本机日志与检查点。

校验项目能力清单和完整任务计划：

```bash
npm run projects:validate
npm run plan:check -- .runtime/projects/项目.json < deploy/任务计划.example.json
```

项目交付计划采用固定链路：补丁先在只读 Codex 中生成并校验，再进入隔离 worktree 创建本地提交；测试命令不能由消息临时提供，只能引用项目清单中的 `commandId`。Git 推送固定远端地址和 `ai-employee/` 分支前缀，生产发布必须同时登记发布、验收和回滚命令。任何项目授权或命令定义变化都会改变计划哈希，使旧审批失效。

当回复判断识别到“研究、写方案、改代码、测试、推送、上线”等明确工作请求，且生产能力包含 `work_plan_proposal` 时，Worker 会匹配请求人有权访问的项目，并用只读 Codex 生成计划提案。没有授权项目时拒绝；同时匹配多个项目且消息未明确项目时不猜测。计划只进入现有 `ready` 或 `awaiting_approval` 状态，不会被 Worker 自动执行。

## 开启真实发送

先在草稿模式验收，再把生产配置中的能力改为：

```json
{
  "AI_EMPLOYEE_ALLOWED_CAPABILITIES": "draft_reply,send_message"
}
```

并确保 `DINGTALK_SELF_USER_ID` 正确，然后重启服务。发送仍然必须逐任务批准；系统不会获得永久发送许可。

## 不回复规则

- “收到”“好的”“谢谢”等确认或闭环。
- 明确表示“不用回”“你先忙”“晚点再说”。
- 只有表情或附件占位。
- 可识别的自动通知和重复回执。
- 合并后仍缺少语义的极短片段。
- 负责人已经人工回复。

Worker 每分钟复查待审批草稿：如果检测到当前账号已在同一会话中、原消息之后人工回复，会把草稿自动标记为“人工已回复并取消”，私聊和白名单群聊均适用。

待审批草稿默认 2 小时后自动失效，避免旧草稿被误批准。人工回复复查会分页覆盖全部仍有效的待审批任务，不受前 100 条限制。

群聊采用更严格的边界：只读取 `DINGTALK_TARGET_GROUP_IDS` 白名单群中结构化的 `@我` 消息。被 @ 只代表进入判断，并不代表一定回复；仅抄送、公告、闲聊、别人已经回答或没有明确问题时仍不回复。群聊发送使用独立的 `send_group_message` 能力，默认关闭。

为避免服务首次启动时对历史消息“补回复”，超过 `AI_EMPLOYEE_REPLY_MAX_AGE_MS`（默认 2 小时）的消息只归档为不回复。

其他消息进入上下文复核，避免仅凭关键词漏掉真实任务。

## 安全与可靠性

- 生产代码只使用 PostgreSQL；SQLite 仅保留为快速单元测试适配器，不会被生产入口加载，也不会进入发布包。
- 正文、任务载荷、草稿、审批原因和发送回执使用 AES-256-GCM 字段级加密。
- 配置文件必须为 `600`；日志不输出正文和真实联系人 ID。
- Codex 子进程只继承登录、网络和临时目录所需环境，不继承数据库、钉钉或管理密钥。
- DWS 活动文件只作为唤醒信号，消息事实仍通过 DWS 获取。
- 群聊不调用当前账号无权限的完整历史接口；草稿只使用本次 `@我` 消息，避免持续失败和越权读取。
- 任务使用数据库租约和 `FOR UPDATE SKIP LOCKED`，进程崩溃后可恢复。
- 外发使用稳定幂等键；结果未知时转人工核对。
- 每日备份由不同密钥加密，恢复必须显式确认目标数据库。
- 非本机健康端口必须配置 Bearer Token。
- 管理台始终只监听本机，并强制使用相互独立的读、写令牌；页面没有执行计划和发送消息按钮。
- 外部告警必须使用 HTTPS 和 HMAC-SHA256 签名，正文保持脱敏。

更完整的边界见[安全说明](./安全说明.md)。

## 验证

```bash
npm run check
npm run check:security
npm pack --dry-run
npm run reuse:verify
```

`reuse:verify` 会真实生成 tarball、安装到空目录、解析安装后的全部源码、初始化受保护配置、验证不可覆盖，再创建并校验一个默认无外部权限的项目清单；它不会连接生产数据库、钉钉或 Codex。GitHub 检查会在 Node.js 22 和 24 上启动真实 PostgreSQL 16，执行迁移、并发租约、审批、幂等和加密集成测试，并运行该隔离安装验收、依赖审计与 CodeQL。

## 文档

- [产品需求文档](./docs/产品需求文档.md)
- [设计总览](./docs/设计总览.md)
- [技术设计文档](./docs/技术设计文档.md)
- [生产运维手册](./docs/生产运维手册.md)
- [安全说明](./安全说明.md)

## 许可证

本项目采用 [MIT 许可证](./许可证.md)，允许在保留版权和许可声明的前提下使用、修改和分发。`private: true` 仅用于防止误发布到 npm，不影响 Git 仓库代码复用。
