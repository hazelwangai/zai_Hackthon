CREATE TABLE IF NOT EXISTS api_keys (
  id              SERIAL PRIMARY KEY,
  api_key_enc     TEXT NOT NULL,                 -- AES 加密后的 Key（明文不落库）
  api_key_hash    TEXT NOT NULL UNIQUE,          -- 确定性指纹：保证 Key 唯一、可去重
  source_email    TEXT,                          -- 内部：来源 Zai 邮箱，从不下发给选手
  claim_count     INTEGER NOT NULL DEFAULT 0,    -- 该 Key 已发给多少个选手（计数器）
  is_full         BOOLEAN NOT NULL DEFAULT FALSE,-- 计数达上限后标记为已发送(发满)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 每个选手领取记录：保证同一选手始终拿回同一个 Key、且不重复计数
CREATE TABLE IF NOT EXISTS claims (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,            -- 选手邮箱（唯一）
  key_id        INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  claimed_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claims_email ON claims (email);
CREATE INDEX IF NOT EXISTS idx_claims_key ON claims (key_id);
CREATE INDEX IF NOT EXISTS idx_keys_open ON api_keys (id) WHERE is_full = FALSE;
