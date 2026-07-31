# AI 员工

基于 DWS、Codex 和 PostgreSQL 的钉钉 AI 员工。它实时发现白名单联系人的新消息，合并连续消息，判断是否需要回复，生成草稿，并在逐任务审批后受控发送。

生产默认是“草稿模式”：可以监听、判断和生成草稿，不能自行外发。开启发送仍必须同时满足能力开关、人工审批、发送前人工回复复查和幂等账本。

## 已实现能力

| 能力 | 生产状态 | 边界 |
|---|---|---|
| 钉钉消息监听 | 可用 | 只读取配置中的单聊联系人 |
| 实时唤醒与补漏 | 可用 | 本地活动信号唤醒，5 分钟增量检查兜底 |
| 消息与任务可靠性 | 可用 | PostgreSQL 去重、事务、租约、重试和死信 |
| 连续消息合并 | 可用 | 默认等待 3 秒后合并判断 |
| 判断是否回复 | 可用 | 明确闭环走硬规则，其余由 Codex 结合上下文复核 |
| 草稿生成 | 可用 | 独立 Worker、只读 Codex 沙箱 |
| 人工审批与发送 | 可用、默认关闭 | 每条消息单次批准；未知结果不自动重发 |
| 健康与指标 | 可用 | 深度就绪检查、组件心跳和 Prometheus 指标 |
| 常驻与恢复 | 可用 | macOS LaunchAgent、数据库迁移、加密备份和恢复 |
| 代码、共享文档和生产发布 | 未授权 | 当前运行时不会接受这类副作用任务 |

最后一行是能力边界，不是故障：消息里的文字不能自行扩大 AI 权限。后续开放代码或部署时，必须另行绑定项目目录、审批、验收和回滚。

## 生产要求

- macOS，已登录钉钉桌面端。
- Node.js 22.5 或更高版本。
- DWS、Codex CLI、`pg_dump` 和 `pg_restore`。
- PostgreSQL 16。
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

3. 从[生产配置示例](./deploy/生产配置.example.json)复制为 `.runtime/production.json`，填写真实值并收紧权限：

```bash
cp deploy/生产配置.example.json .runtime/production.json
chmod 600 .runtime/production.json
```

数据密钥和备份密钥必须分别生成，不能相同：

```bash
openssl rand -base64 32
openssl rand -base64 32
```

4. 运行生产预检。它会检查配置、密钥、远程数据库 TLS、所需工具、数据库连接，并在事务中执行迁移：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run production:preflight
```

5. 安装并启动监听、Worker、健康检查和每日备份：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run service:install
```

6. 验证所有依赖和组件心跳：

```bash
AI_EMPLOYEE_CONFIG_FILE="$PWD/.runtime/production.json" \
  npm run production:verify
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

批准、拒绝或重试：

```bash
npm run control -- approve <任务ID> "同意发送"
npm run control -- reject <任务ID> "改为人工回复"
npm run control -- retry <任务ID>
```

暂停和恢复：

```bash
npm run control -- pause
npm run control -- resume
```

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

其他消息进入上下文复核，避免仅凭关键词漏掉真实任务。

## 安全与可靠性

- 生产代码只使用 PostgreSQL；SQLite 仅保留为快速单元测试适配器，不会被生产入口加载，也不会进入发布包。
- 正文、任务载荷、草稿、审批原因和发送回执使用 AES-256-GCM 字段级加密。
- 配置文件必须为 `600`；日志不输出正文和真实联系人 ID。
- DWS 活动文件只作为唤醒信号，消息事实仍通过 DWS 获取。
- 任务使用数据库租约和 `FOR UPDATE SKIP LOCKED`，进程崩溃后可恢复。
- 外发使用稳定幂等键；结果未知时转人工核对。
- 每日备份由不同密钥加密，恢复必须显式确认目标数据库。
- 非本机健康端口必须配置 Bearer Token。

更完整的边界见[安全说明](./安全说明.md)。

## 验证

```bash
npm run check
npm run check:security
npm pack --dry-run
```

GitHub 检查会在 Node.js 22 和 24 上启动真实 PostgreSQL 16，执行迁移、并发租约、审批、幂等和加密集成测试，并运行依赖审计与 CodeQL。

## 文档

- [产品需求文档](./docs/产品需求文档.md)
- [设计总览](./docs/设计总览.md)
- [技术设计文档](./docs/技术设计文档.md)
- [生产运维手册](./docs/生产运维手册.md)
- [安全说明](./安全说明.md)

## 许可证

当前仓库未授予开源许可证。公开可见不代表允许复制、修改或分发。
