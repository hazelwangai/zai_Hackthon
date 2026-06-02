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

// AES-256-GCM：存储 base64( iv[12] + tag[16] + ciphertext )
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

// 确定性指纹：同一个 Key 永远同一 hash，用于唯一/去重，不暴露明文
export function hashKey(plain) {
  return crypto.createHmac('sha256', getKey()).update(String(plain)).digest('hex');
}

export function normEmail(e) { return String(e || '').trim().toLowerCase(); }

// 恒定时间比较管理员令牌
export function checkAdmin(token) {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return false;
  const a = Buffer.from(String(token || '')), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
