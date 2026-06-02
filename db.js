import pg from 'pg';
import crypto from 'crypto';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

function getKey() {
  const raw = process.env.ENC_KEY;
  if (!raw) throw new Error('ENC_KEY 未设置：请在环境变量里设置一个加密密钥');
  return crypto.createHash('sha256').update(String(raw)).digest();
}

export function encrypt(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(blob) {
  const key = getKey();
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function hashKey(plain) {
  return crypto.createHmac('sha256', getKey()).update(String(plain)).digest('hex');
}

export function normEmail(e) { return String(e || '').trim().toLowerCase(); }

// 每个 Key 最多发给多少个选手（默认 10），可用环境变量覆盖
export function maxPerKey() {
  return parseInt(process.env.MAX_PER_KEY || '10', 10);
}

// 管理员口令：默认 071926z.ai，可用环境变量 ADMIN_TOKEN 覆盖
function adminToken() {
  return process.env.ADMIN_TOKEN || '071926z.ai';
}

export function checkAdmin(token) {
  const expected = adminToken();
  const a = Buffer.from(String(token || '')), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
