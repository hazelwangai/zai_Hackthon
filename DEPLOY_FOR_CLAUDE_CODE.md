# 给 Claude Code 的部署任务说明

这是一个 Node (Express) + PostgreSQL 的 API Key 自助领取系统，要部署到 Zeabur（用户已购买专用服务器，伦敦区）。

## 背景 / 已知状态
- 用户**尚未**在 Zeabur 建库、也没领过数据，所以**不需要任何数据迁移**，全新部署即可。
- `keys.json` 含 40 个唯一 API Key（已去重、已验证无重复）。
- 数据库表在服务启动时由 `server.js` 自动创建（`ensureSchema()` 跑 `schema.sql`，幂等）。

## 业务规则（已实现，无需改动逻辑）
- 每个 Key 最多发给 `MAX_PER_KEY`（默认 10）个不同选手；发满后标记 `is_full`，新选手自动落到下一个未满的 Key。
- 同一选手重复领取，始终返回其首次拿到的同一个 Key，不重复计数（靠 `claims` 表的 email 唯一约束）。
- 选手端 `/`，管理端 `/admin`，管理默认口令 `071926z.ai`。

## 部署步骤（请协助用户在 Zeabur 完成）

1. 推送代码到 GitHub 仓库 `https://github.com/hazelwangai/zai_Hackthon.git`：
   ```bash
   git init && git add . && git commit -m "deploy: api key dispenser v2 (40 keys, counter, admin)"
   git branch -M main
   git remote add origin https://github.com/hazelwangai/zai_Hackthon.git   # 已存在则用 set-url
   git push -u origin main
   ```
   注意：`.gitignore` 默认排除 `keys.json` 与 `.env`。本仓库是 Private 时，可删掉 `.gitignore` 里的 `keys.json` 一行，让 40 个 Key 随仓库部署；否则 Key 不进仓库，需在部署后用 `/admin` 手动添加或单独上传 keys.json。

2. Zeabur：在已购买的服务器上 New Project → Add Service → PostgreSQL。

3. Add Service → Git → 选该仓库（自动识别 Node，`npm install` + `npm start`）。

4. 在 Node 服务 Variables 设置：
   - `ENC_KEY`：用 `openssl rand -hex 32` 生成，**部署后不要再改**。
   - `ADMIN_TOKEN`：可不设（默认 `071926z.ai`），建议设成自定义值更安全。
   - `DATABASE_URL`：用 Zeabur 变量引用绑定 Postgres 服务的连接串。
   - 可选：`MAX_PER_KEY`（默认 10）、`LOW_STOCK_THRESHOLD`（默认 10）、`NOTIFY_WEBHOOK_URL`、`NOTIFY_TYPE`。

5. 导入 40 个 Key（二选一）：
   - 若 keys.json 已随仓库部署：在服务 Terminal 跑 `npm run init-db`（幂等，已存在会跳过）。
   - 否则：打开 `/admin` 用口令登录后逐个/批量手动添加。

6. Networking 绑定域名。选手用 `https://域名/`，管理员用 `https://域名/admin`。

## 验证
- `GET /` 输入邮箱能领到 Key；同一邮箱二次领取拿到同一个。
- `/admin` 登录后看到 40 个 Key、计数进度条、剩余名额随领取实时变化。
- 连领 11 个不同邮箱：第 1 个 Key 计数到 10/10 变「已发满」，第 11 个落到第 2 个 Key。
