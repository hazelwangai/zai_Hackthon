# API Key 自助领取系统（含管理后台）

> 分配规则（重要）：每个 API Key 最多发给 **10 个**选手（可用 `MAX_PER_KEY` 调整）。
> 每来一个**新**选手，系统给他当前未发满的那个 Key 并把计数器 +1；某个 Key 计满 10 即标记「已发满」，
> 之后的新选手自动落到下一个未满的 Key。**同一个选手重复查询，始终返回他第一次拿到的同一个 Key，不重复计数。**
> 管理后台默认口令：`071926z.ai`（可用环境变量 `ADMIN_TOKEN` 覆盖）。


一个网址、一个在线数据库（Zeabur Postgres），分两种角色：

- **选手（用户）** `/`：输入报名邮箱 → 实时领取一个专属 API Key。一个邮箱有且仅有一个 Key（重复领取返回同一个），一个 Key 只发一个邮箱（数据库原子锁）。
- **管理员** `/admin`：口令登录后可新增/修改/删除 Key、维护来源 Zai 邮箱、**实时**查看每个 Key 的发放状态（每 4 秒自动刷新，状态变化会高亮），并在剩余 ≤ 阈值 / 发完时收到提醒。

Key 在数据库里 **AES-256-GCM 加密存储**；前端与开发者视图中没有任何 Key；选手只能拿到自己那一个。

## 角色与权限

| 能力 | 选手 | 管理员 |
|---|---|---|
| 输入邮箱领取自己的 Key | ✅ | ✅ |
| 看到别人的 Key / 整个池 | ❌ | ✅（口令登录后） |
| 新增 / 修改 / 删除 Key | ❌ | ✅ |
| 维护来源 Zai 邮箱 | ❌ | ✅ |
| 实时看发放状态 | ❌ | ✅ |
| 低库存 / 发完通知 | — | ✅ |

## 文件

```
server.js          Express：选手接口 + 管理员接口（启动自动建表）
db.js              Postgres + AES 加解密 + Key 指纹 + 管理员校验
notify.js          低库存 / 发完 的 webhook 通知
schema.sql         表结构（Key 唯一指纹 + 选手邮箱唯一）
seed.js            把 keys.json 加密导入（幂等，可重复跑，自动跳过已存在）
keys.json          初始 Key 池（内部文件，不被前端访问）
public/index.html  选手页面
public/admin.html  管理后台
.env.example       环境变量
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres 连接串（Zeabur 绑定 Postgres 后自动注入） |
| `ENC_KEY` | ✅ | 加密密钥，`openssl rand -hex 32`，**部署后别改** |
| `ADMIN_TOKEN` | ✅ | 管理后台登录口令 |
| `LOW_STOCK_THRESHOLD` | 选填 | 剩余多少时提醒，默认 10 |
| `NOTIFY_WEBHOOK_URL` | 选填 | Slack/Discord/飞书机器人地址；不填则只在后台页面提醒 |
| `NOTIFY_TYPE` | 选填 | `slack`/`discord`/`feishu`/`generic`，默认 generic |

## 部署到 Zeabur

1. 代码推到 Git 仓库。
2. Zeabur 新建 Project → Add Service → **Postgres**。
3. 同 Project → Add Service → **Git**，选仓库（自动 Node 构建并 `npm start`）。
4. Node 服务 Variables 里设置：`ENC_KEY`、`ADMIN_TOKEN`，并把 Postgres 的连接变量引用为 `DATABASE_URL`；需要外部通知再加 `NOTIFY_WEBHOOK_URL` / `NOTIFY_TYPE`。
5. 服务 Terminal 跑一次 `npm run init-db` 导入初始 Key 池（也可全部在后台手动添加，则跳过此步）。
6. 绑定域名。选手用根地址 `https://你的域名/`，管理员用 `https://你的域名/admin`。

## 本地测试

```bash
cp .env.example .env   # 填 DATABASE_URL / ENC_KEY / ADMIN_TOKEN
npm install
npm run init-db
npm start              # http://localhost:8080  与  http://localhost:8080/admin
```

## 通知说明

每次有选手领取后，系统检查剩余量：**正好剩 `LOW_STOCK_THRESHOLD`（默认 10）个时发一次提醒，剩 0 个时再发一次**（不会每次都刷屏）。配置了 `NOTIFY_WEBHOOK_URL` 就会推到你的群机器人；无论是否配置，管理后台顶部都会显示黄/红横幅。

## 换成正确的 Key 表

把新表生成 `keys.json`（`[{"api_key","source_email"}]`）后 `npm run init-db`（已存在的会自动跳过、只新增）。要整体重置则先在数据库 `TRUNCATE api_keys;` 再导入。

## 安全备注

- 全程走 HTTPS（Zeabur 自带），管理员口令以 Bearer 形式随请求发送，服务端恒定时间比对。
- 选手领取后，他自己那一个 Key 会出现在他本人浏览器的网络响应里（必须如此，Key 要给他用）；别人看不到、也扒不到整池。
- 需要防刷（报名邮箱白名单、验证码、IP 限流）可再加，告诉我即可。
