import fs from 'fs';
import { pool, encrypt, hashKey } from './db.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const keysUrl = new URL('./keys.json', import.meta.url);

async function main() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    if (!fs.existsSync(keysUrl)) {
      console.log('未找到 keys.json，跳过导入。可在管理后台 /admin 手动添加 Key。');
      return;
    }
    const keys = JSON.parse(fs.readFileSync(keysUrl, 'utf8'));
    let inserted = 0, skipped = 0;
    for (const k of keys) {
      const r = await client.query(
        `INSERT INTO api_keys (api_key_enc, api_key_hash, source_email)
         VALUES ($1, $2, $3) ON CONFLICT (api_key_hash) DO NOTHING`,
        [encrypt(k.api_key), hashKey(k.api_key), k.source_email || null]
      );
      if (r.rowCount === 1) inserted++; else skipped++;
    }
    console.log(`导入完成：新增 ${inserted} 个，已存在跳过 ${skipped} 个。`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
