CREATE TABLE IF NOT EXISTS api_keys (
  id              SERIAL PRIMARY KEY,
  api_key_enc     TEXT NOT NULL,                 -- AES 加密后的 Key（明文不落库）
  api_key_hash    TEXT NOT NULL UNIQUE,          -- 确定性指纹：保证 Key 唯一、可去重
  source_email    TEXT,                          -- 内部：来源 Zai 邮箱，从不下发给选手
  assigned_email  TEXT,                          -- 领取的选手邮箱（NULL = 未发放）
  assigned_at     TIMESTAMPTZ,                   -- 领取时间
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_assigned_email UNIQUE (assigned_email)  -- 一个选手最多一个 Key
);
CREATE INDEX IF NOT EXISTS idx_assigned_email ON api_keys (assigned_email);
CREATE INDEX IF NOT EXISTS idx_unassigned ON api_keys (id) WHERE assigned_email IS NULL;
