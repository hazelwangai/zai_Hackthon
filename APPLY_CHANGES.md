# 给 Claude Code 的任务：升级到 v4（报名白名单）并部署

## 背景
这是一个已部署在 Zeabur 的 Node(Express)+PostgreSQL 项目（API Key 自助领取）。
线上地址：https://zai-hackthon.zeabur.app
GitHub：https://github.com/hazelwangai/zai_Hackthon
推送到 main 后 Zeabur 会自动重新部署。

## 最稳做法
如果用户手头有最新的 `apikey-dispenser.zip`（由助手提供），**直接用它的内容覆盖本仓库同名文件**，然后提交推送即可，无需手改。覆盖后执行：
```
git add .
git commit -m "v4: registration whitelist + bulk import + multi-admin + login lockout"
git push
```

## 如果要手动改（没有 zip 时），需要实现以下变更

本次新增「报名白名单」：只有名单内邮箱能领取 Key。在已有 v3（多管理员、登录锁定、批量导入）基础上叠加。

### 1) schema.sql —— 新增 whitelist 表
```sql
CREATE TABLE IF NOT EXISTS whitelist (
  email     TEXT PRIMARY KEY,
  added_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### 2) server.js —— /api/claim 在邮箱格式校验通过后、事务开始前，加白名单检查
```js
const enforce = (process.env.WHITELIST_ENFORCED || 'true').toLowerCase() !== 'false';
// 在 await client.query('BEGIN') 之前：
if (enforce) {
  const wl = await client.query('SELECT 1 FROM whitelist WHERE email = $1', [email]);
  if (wl.rowCount === 0) {
    return res.status(403).json({ error: 'not_registered', message: '该邮箱不在报名名单中，请确认使用报名时填写的邮箱，或联系管理员。' });
  }
}
```

### 3) server.js —— statsOf() 增加白名单计数
在组装返回对象时加：
```js
const wl = await client.query('SELECT COUNT(*)::int AS n FROM whitelist');
s.whitelist = wl.rows[0].n;
s.enforce = (process.env.WHITELIST_ENFORCED || 'true').toLowerCase() !== 'false';
```

### 4) server.js —— 新增白名单管理路由（均需 requireAdmin）
- `GET    /api/admin/whitelist`              列出名单（LEFT JOIN claims 标记是否已领取）
- `POST   /api/admin/whitelist/bulk` {text}  批量导入：按 /[\r\n,;\t ]+/ 拆分、normEmail、EMAIL_RE 过滤、去重，逐个 `INSERT ... ON CONFLICT (email) DO NOTHING`，返回 {added, skipped, invalid, unique}
- `DELETE /api/admin/whitelist/:email`       删除单个
- `DELETE /api/admin/whitelist`              清空

### 5) public/admin.html —— 加「报名名单」面板
- 顶部统计加一格「报名人数」(sWl)
- 一个 textarea + 「导入名单 / 查看名单 / 清空名单」按钮，调用上面的接口
- 标题旁显示白名单启用状态（enforce 为真显示「已启用」绿色，否则红色）

### 6) .env.example / 环境变量
新增 `WHITELIST_ENFORCED=true`（默认启用；设 false 关闭白名单）。

## 部署后请提醒用户的操作顺序（很重要）
1. 在 Zeabur 确认环境变量：`ENC_KEY`、`DATABASE_URL`、`ADMIN_TOKEN`（已设）。白名单默认启用，无需额外设变量。
2. 打开 /admin 登录 → 先「批量导入」40 个 API Key（若未导）。
3. 再在「报名名单」面板把全部报名邮箱粘贴导入。
4. **先导名单、再把领取链接发给选手**。因为白名单默认开启、名单为空时所有人都会被拒。

## 验证
- 未在名单中的邮箱领取 → 返回 403「该邮箱不在报名名单中」。
- 名单中的邮箱领取 → 拿到一个 Key；同一邮箱重复领取拿同一个。
- /admin 顶部能看到「报名人数」，标题旁显示「已启用」。
