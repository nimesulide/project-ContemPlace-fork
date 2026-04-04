-- ============================================================
-- USER TABLES
-- New tables for multi-tenant user management.
-- refs #002-multi-tenant-mvp
-- ============================================================

-- ============================================================
-- USER PROFILES
-- One profile per auth.users row. Provisioned by trigger.
-- ============================================================
CREATE TABLE user_profiles (
  user_id       uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text,
  mcp_api_key_hash text     UNIQUE,
  plan          text        NOT NULL DEFAULT 'free',
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own profile" ON user_profiles
  FOR SELECT USING (user_id = auth.uid());

-- ============================================================
-- TELEGRAM CONNECTIONS
-- Maps Telegram chat IDs to user accounts. One chat per user.
-- ============================================================
CREATE TABLE telegram_connections (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id       bigint      NOT NULL UNIQUE,
  connected_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own telegram connection" ON telegram_connections
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can delete own telegram connection" ON telegram_connections
  FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- TELEGRAM LINK TOKENS
-- Ephemeral tokens for Telegram deep link connection flow.
-- ============================================================
CREATE TABLE telegram_link_tokens (
  token         text        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

ALTER TABLE telegram_link_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON telegram_link_tokens FOR ALL USING (false);
