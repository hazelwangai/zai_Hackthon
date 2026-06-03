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

// 管理员口令：
//  - ADMIN_TOKEN：单个口令（向后兼容，默认 071926z.ai）
//  - ADMIN_TOKENS：多个管理员，逗号分隔；每项可写 "名字:口令" 或只写 "口令"
//    例：ADMIN_TOKENS="hazel:abc123,teammate:xyz789"
function adminList() {
  const out = [];
  const single = process.env.ADMIN_TOKEN || (process.env.ADMIN_TOKENS ? '' : '071926z.ai');
  if (single) out.push({ name: 'admin', token: single });
  const multi = process.env.ADMIN_TOKENS || '';
  for (const part of multi.split(',').map((x) => x.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx > 0) out.push({ name: part.slice(0, idx).trim(), token: part.slice(idx + 1).trim() });
    else out.push({ name: 'admin', token: part });
  }
  return out;
}

function ctEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// 校验口令，返回匹配到的管理员名字（不匹配返回 null）
export function adminNameForToken(token) {
  for (const a of adminList()) {
    if (ctEqual(token, a.token)) return a.name;
  }
  return null;
}

export function checkAdmin(token) {
  return adminNameForToken(token) !== null;
}
