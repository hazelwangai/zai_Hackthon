import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, encrypt, decrypt, hashKey, normEmail, checkAdmin } from './db.js';
import { maybeNotifyStock } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

async function statsOf(client = pool) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(assigned_email)::int AS claimed,
            COUNT(*) FILTER (WHERE assigned_email IS NULL)::int AS remaining
     FROM api_keys`
  );
  const s = r.rows[0];
  const threshold = parseInt(process.env.LOW_STOCK_THRESHOLD || '10', 10);
  s.threshold = threshold;
  s.low = s.remaining <= threshold && s.remaining > 0;
  s.empty = s.remaining === 0;
  return s;
}

/* ============ 选手（用户）端 ============ */
app.post('/api/claim', async (req, res) => {
  const email = normEmail(req.body?.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email', message: '邮箱格式不正确' });

  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT api_key_enc FROM api_keys WHERE assigned_email = $1 LIMIT 1', [email]);
    if (existing.rowCount > 0) return res.json({ key: decrypt(existing.rows[0].api_key_enc), status: 'existing' });

    try {
      const claim = await client.query(
        `WITH picked AS (
           SELECT id FROM api_keys WHERE assigned_email IS NULL
           ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         UPDATE api_keys k SET assigned_email = $1, assigned_at = NOW()
         FROM picked WHERE k.id = picked.id
         RETURNING k.api_key_enc`,
        [email]
      );
      if (claim.rowCount === 0) return res.status(409).json({ error: 'pool_empty', message: '可用 Key 已发完，请联系管理员' });

      // 触发库存阈值通知（不阻塞响应）
      statsOf(client).then((s) => maybeNotifyStock(s.remaining)).catch(() => {});
      return res.json({ key: decrypt(claim.rows[0].api_key_enc), status: 'new' });
    } catch (e) {
      if (e.code === '23505') {
        const again = await client.query('SELECT api_key_enc FROM api_keys WHERE assigned_email = $1 LIMIT 1', [email]);
        if (again.rowCount > 0) return res.json({ key: decrypt(again.rows[0].api_key_enc), status: 'existing' });
      }
      throw e;
    }
  } catch (e) {
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

// 校验口令（供后台登录用）
app.post('/api/admin/login', (req, res) => {
  if (!checkAdmin(req.body?.password)) return res.status(401).json({ ok: false, message: '口令错误' });
  res.json({ ok: true });
});

// 库存统计
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try { res.json(await statsOf()); }
  catch (e) { res.status(500).json({ error: 'server_error' }); }
});

// 列出所有 Key（管理员可见明文，含发放状态，实时刷新）
app.get('/api/admin/keys', requireAdmin, async (req, res) => {
  try {
    const filter = req.query.status; // all | assigned | unassigned
    let where = '';
    if (filter === 'assigned') where = 'WHERE assigned_email IS NOT NULL';
    else if (filter === 'unassigned') where = 'WHERE assigned_email IS NULL';
    const r = await pool.query(
      `SELECT id, api_key_enc, source_email, assigned_email, assigned_at
       FROM api_keys ${where} ORDER BY id`
    );
    const keys = r.rows.map((row) => ({
      id: row.id,
      api_key: decrypt(row.api_key_enc),
      source_email: row.source_email,
      assigned_email: row.assigned_email,
      assigned_at: row.assigned_at,
      status: row.assigned_email ? 'assigned' : 'unassigned',
    }));
    res.json({ keys, stats: await statsOf() });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

// 新增 Key（可带来源 Zai 邮箱）
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

// 修改 Key 的明文 / 来源邮箱
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

// 回收某个 Key 的发放（清空 assigned_email，使其可再次领取）
app.post('/api/admin/keys/:id/release', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await pool.query('UPDATE api_keys SET assigned_email = NULL, assigned_at = NULL WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 删除 Key
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
