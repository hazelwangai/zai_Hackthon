import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, encrypt, decrypt, hashKey, normEmail, checkAdmin, adminNameForToken, maxPerKey } from './db.js';
import { maybeNotifyStock } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ====== 登录失败锁定（内存版，单实例够用）======
   同一 IP 连续失败 MAX_FAILS 次，锁定 LOCK_MINUTES 分钟 */
const MAX_FAILS = parseInt(process.env.LOGIN_MAX_FAILS || '5', 10);
const LOCK_MINUTES = parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10);
const loginFails = new Map(); // ip -> { count, lockedUntil }
function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || 'unknown';
}
function loginState(ip) {
  const s = loginFails.get(ip);
  if (s && s.lockedUntil && s.lockedUntil < Date.now()) { loginFails.delete(ip); return null; }
  return s || null;
}
function recordFail(ip) {
  const s = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  s.count += 1;
  if (s.count >= MAX_FAILS) s.lockedUntil = Date.now() + LOCK_MINUTES * 60 * 1000;
  loginFails.set(ip, s);
}
function clearFails(ip) { loginFails.delete(ip); }

async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

// 统计：以「还能接新选手的容量」为口径
// total 容量 = Key 数 × 每 Key 上限；claimed = 已领取选手数；remaining = 剩余可领名额
async function statsOf(client = pool) {
  const cap = maxPerKey();
  const r = await client.query(
    `SELECT
        (SELECT COUNT(*)::int FROM api_keys) AS key_total,
        (SELECT COUNT(*)::int FROM api_keys WHERE is_full) AS key_full,
        (SELECT COUNT(*)::int FROM claims) AS claimed,
        (SELECT COALESCE(SUM(${cap} - claim_count),0)::int FROM api_keys) AS remaining`
  );
  const s = r.rows[0];
  const wl = await client.query('SELECT COUNT(*)::int AS n FROM whitelist');
  s.whitelist = wl.rows[0].n;
  s.enforce = (process.env.WHITELIST_ENFORCED || 'true').toLowerCase() !== 'false';
  const threshold = parseInt(process.env.LOW_STOCK_THRESHOLD || '10', 10);
  s.cap = cap;
  s.capacity = s.key_total * cap;
  s.threshold = threshold;
  s.low = s.remaining <= threshold && s.remaining > 0;
  s.empty = s.remaining === 0;
  return s;
}

/* ============ 选手（用户）端 ============ */
app.post('/api/claim', async (req, res) => {
  const email = normEmail(req.body?.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email', message: '邮箱格式不正确' });

  const cap = maxPerKey();
  const enforce = (process.env.WHITELIST_ENFORCED || 'true').toLowerCase() !== 'false';

  const client = await pool.connect();
  try {
    // 0) 白名单校验：开启时，非报名邮箱直接拒绝
    if (enforce) {
      const wl = await client.query('SELECT 1 FROM whitelist WHERE email = $1', [email]);
      if (wl.rowCount === 0) {
        return res.status(403).json({ error: 'not_registered', message: '该邮箱不在报名名单中，请确认使用报名时填写的邮箱，或联系管理员。' });
      }
    }

    await client.query('BEGIN');

    // 1) 这个选手已经领过 → 返回原来的 Key（不重复计数）
    const existing = await client.query(
      `SELECT k.api_key_enc FROM claims c JOIN api_keys k ON k.id = c.key_id WHERE c.email = $1`,
      [email]
    );
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      return res.json({ key: decrypt(existing.rows[0].api_key_enc), status: 'existing' });
    }

    // 2) 新选手 → 锁一个未满的 Key（claim_count < cap），优先填还差名额最少的，保证发满一个再开下一个
    const pick = await client.query(
      `SELECT id, api_key_enc, claim_count FROM api_keys
       WHERE claim_count < $1
       ORDER BY claim_count DESC, id ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [cap]
    );
    if (pick.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'pool_empty', message: '名额已发完，请联系管理员' });
    }

    const keyRow = pick.rows[0];
    const newCount = keyRow.claim_count + 1;
    await client.query(
      `UPDATE api_keys SET claim_count = $1, is_full = ($1 >= $2) WHERE id = $3`,
      [newCount, cap, keyRow.id]
    );
    await client.query(
      `INSERT INTO claims (email, key_id) VALUES ($1, $2)`,
      [email, keyRow.id]
    );
    await client.query('COMMIT');

    statsOf().then((s) => maybeNotifyStock(s.remaining)).catch(() => {});
    return res.json({ key: decrypt(keyRow.api_key_enc), status: 'new' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // 并发下同一邮箱重复插入触发 claims.email 唯一约束 → 取回已分配
    if (e.code === '23505') {
      try {
        const again = await pool.query(
          `SELECT k.api_key_enc FROM claims c JOIN api_keys k ON k.id = c.key_id WHERE c.email = $1`,
          [email]
        );
        if (again.rowCount > 0) return res.json({ key: decrypt(again.rows[0].api_key_enc), status: 'existing' });
      } catch (_) {}
    }
    console.error(e);
    res.status(500).json({ error: 'server_error', message: '服务器出错，请稍后再试' });
  } finally {
    client.release();
  }
});

/* ============ 管理员鉴权 ============ */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!checkAdmin(token)) return res.status(401).json({ error: 'unauthorized', message: '管理员口令错误' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const ip = clientIp(req);
  const st = loginState(ip);
  if (st && st.lockedUntil && st.lockedUntil > Date.now()) {
    const mins = Math.ceil((st.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ ok: false, message: `尝试过多，请 ${mins} 分钟后再试` });
  }
  const name = adminNameForToken(req.body?.password);
  if (!name) {
    recordFail(ip);
    const s2 = loginState(ip);
    const left = s2 ? Math.max(0, MAX_FAILS - s2.count) : MAX_FAILS;
    return res.status(401).json({ ok: false, message: left > 0 ? `口令错误，还可尝试 ${left} 次` : '尝试过多，已临时锁定' });
  }
  clearFails(ip);
  res.json({ ok: true, name });
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try { res.json(await statsOf()); }
  catch (e) { res.status(500).json({ error: 'server_error' }); }
});

// 列出所有 Key（含计数器、发满标记、各自领取的选手名单）
app.get('/api/admin/keys', requireAdmin, async (req, res) => {
  try {
    const filter = req.query.status; // all | full | open
    let where = '';
    if (filter === 'full') where = 'WHERE is_full';
    else if (filter === 'open') where = 'WHERE NOT is_full';
    const r = await pool.query(
      `SELECT k.id, k.api_key_enc, k.source_email, k.claim_count, k.is_full,
              COALESCE(json_agg(json_build_object('email', c.email, 'at', c.claimed_at)
                       ORDER BY c.claimed_at) FILTER (WHERE c.email IS NOT NULL), '[]') AS claimers
       FROM api_keys k LEFT JOIN claims c ON c.key_id = k.id
       ${where}
       GROUP BY k.id ORDER BY k.id`
    );
    const cap = maxPerKey();
    const keys = r.rows.map((row) => ({
      id: row.id,
      api_key: decrypt(row.api_key_enc),
      source_email: row.source_email,
      claim_count: row.claim_count,
      cap,
      is_full: row.is_full,
      status: row.is_full ? 'full' : 'open',
      claimers: row.claimers,
    }));
    res.json({ keys, stats: await statsOf() });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  const apiKey = String(req.body?.api_key || '').trim();
  const sourceEmail = req.body?.source_email ? normEmail(req.body.source_email) : null;
  if (!apiKey) return res.status(400).json({ error: 'invalid', message: 'API Key 不能为空' });
  try {
    const r = await pool.query(
      `INSERT INTO api_keys (api_key_enc, api_key_hash, source_email)
       VALUES ($1, $2, $3) ON CONFLICT (api_key_hash) DO NOTHING RETURNING id`,
      [encrypt(apiKey), hashKey(apiKey), sourceEmail]
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'duplicate', message: '该 Key 已存在' });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 批量导入：每行一个 Key，可选用逗号/竖线/制表符在 Key 后写来源邮箱
app.post('/api/admin/keys/bulk', requireAdmin, async (req, res) => {
  const text = String(req.body?.text || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0, skipped = 0, invalid = 0;
  const client = await pool.connect();
  try {
    for (const line of lines) {
      // 去掉行首序号 "12. " / "12) "
      const cleaned = line.replace(/^\s*\d+[.)]\s*/, '').trim();
      // Key = 第一个分隔符（空白/逗号/竖线/制表符）之前的片段
      const apiKey = cleaned.split(/[\s,|\t]+/)[0];
      // 来源 = 行内任意位置出现的邮箱（排除把 Key 当来源）
      let source = null;
      const m = cleaned.slice(apiKey.length).match(/[^\s,|()（）]+@[^\s,|()（）]+\.[^\s,|()（）]+/);
      if (m) source = m[0];
      if (!apiKey) { invalid++; continue; }
      try {
        const r = await client.query(
          `INSERT INTO api_keys (api_key_enc, api_key_hash, source_email)
           VALUES ($1, $2, $3) ON CONFLICT (api_key_hash) DO NOTHING RETURNING id`,
          [encrypt(apiKey), hashKey(apiKey), source]
        );
        if (r.rowCount === 1) added++; else skipped++;
      } catch (_) { invalid++; }
    }
    res.json({ ok: true, added, skipped, invalid, total: lines.length });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  } finally { client.release(); }
});

/* ============ 报名白名单管理 ============ */
// 列出白名单（含每个邮箱是否已领取）
app.get('/api/admin/whitelist', requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT w.email, w.added_at, (c.email IS NOT NULL) AS claimed
       FROM whitelist w LEFT JOIN claims c ON c.email = w.email
       ORDER BY w.added_at DESC, w.email`
    );
    res.json({ emails: r.rows, count: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 批量导入报名邮箱：每行/每个逗号分隔一个邮箱，自动去空格、转小写、去重
app.post('/api/admin/whitelist/bulk', requireAdmin, async (req, res) => {
  const text = String(req.body?.text || '');
  const raw = text.split(/[\r\n,;\t ]+/).map((x) => normEmail(x)).filter(Boolean);
  const valid = [...new Set(raw.filter((e) => EMAIL_RE.test(e)))];
  const invalid = raw.length - raw.filter((e) => EMAIL_RE.test(e)).length;
  let added = 0, skipped = 0;
  const client = await pool.connect();
  try {
    for (const email of valid) {
      const r = await client.query(
        'INSERT INTO whitelist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
        [email]
      );
      if (r.rowCount === 1) added++; else skipped++;
    }
    res.json({ ok: true, added, skipped, invalid, unique: valid.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
  finally { client.release(); }
});

// 删除单个白名单邮箱
app.delete('/api/admin/whitelist/:email', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM whitelist WHERE email = $1', [normEmail(req.params.email)]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 清空白名单
app.delete('/api/admin/whitelist', requireAdmin, async (_req, res) => {
  try { await pool.query('DELETE FROM whitelist'); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.patch('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sets = [], vals = [];
  if (typeof req.body?.api_key === 'string' && req.body.api_key.trim()) {
    const k = req.body.api_key.trim();
    vals.push(encrypt(k)); sets.push(`api_key_enc = $${vals.length}`);
    vals.push(hashKey(k)); sets.push(`api_key_hash = $${vals.length}`);
  }
  if ('source_email' in (req.body || {})) {
    vals.push(req.body.source_email ? normEmail(req.body.source_email) : null);
    sets.push(`source_email = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(id);
  try {
    const r = await pool.query(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'duplicate', message: '该 Key 已存在' });
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

// 重置某个 Key 的发放（清空它的领取记录与计数器）
app.post('/api/admin/keys/:id/reset', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM claims WHERE key_id = $1', [id]);
    const r = await client.query('UPDATE api_keys SET claim_count = 0, is_full = FALSE WHERE id = $1', [id]);
    await client.query('COMMIT');
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); console.error(e); res.status(500).json({ error: 'server_error' }); }
  finally { client.release(); }
});

app.delete('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

const PORT = process.env.PORT || 8080;
ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`API Key dispenser running on :${PORT}`)))
  .catch((e) => { console.error('建表失败:', e); process.exit(1); });
