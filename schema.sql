CREATE TABLE IF NOT EXISTS api_keys (
  id              SERIAL PRIMARY KEY,
  api_key_enc     TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL UNIQUE,
  source_email    TEXT,
  claim_count     INTEGER NOT NULL DEFAULT 0,
  is_full         BOOLEAN NOT NULL DEFAULT FALSE,
  void_count      INTEGER NOT NULL DEFAULT 0,   -- 因「换Key」作废的名额数（仅记录/审计）
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 选手领取记录：一个邮箱始终对应同一个 Key、不重复计数
CREATE TABLE IF NOT EXISTS claims (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  key_id        INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  claimed_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 报名白名单：只有名单内的邮箱才能领取
CREATE TABLE IF NOT EXISTS whitelist (
  email       TEXT PRIMARY KEY,
  added_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claims_email ON claims (email);
CREATE INDEX IF NOT EXISTS idx_claims_key ON claims (key_id);
CREATE INDEX IF NOT EXISTS idx_keys_open ON api_keys (id) WHERE is_full = FALSE;
