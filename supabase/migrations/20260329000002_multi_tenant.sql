-- ============================================================
-- MULTI-TENANT: Add user_id to all existing tables
--
-- Strategy:
--   1. Add user_id as nullable
--   2. Backfill with founder user ID (must exist in auth.users)
--   3. Set NOT NULL
--   4. Add FK constraints and indexes
--
-- The founder user ID must be set before running this migration.
-- Replace the placeholder below with the actual founder UUID.
-- refs #002-multi-tenant-mvp
-- ============================================================

-- ── Helper: get the single existing user or fail ────────────
-- In production, replace this with a hardcoded UUID.
-- For safety, this uses a DO block that sets a session variable.
DO $$
DECLARE
  founder uuid;
BEGIN
  SELECT id INTO founder FROM auth.users LIMIT 1;
  IF founder IS NULL THEN
    RAISE EXCEPTION 'No user found in auth.users. Create a founder user first.';
  END IF;
  PERFORM set_config('app.founder_id', founder::text, true);
END;
$$;

-- ── 1. Add nullable user_id columns ────────────────────────

ALTER TABLE notes             ADD COLUMN user_id uuid;
ALTER TABLE links             ADD COLUMN user_id uuid;
ALTER TABLE clusters          ADD COLUMN user_id uuid;
ALTER TABLE enrichment_log    ADD COLUMN user_id uuid;
ALTER TABLE capture_profiles  ADD COLUMN user_id uuid;
ALTER TABLE processed_updates ADD COLUMN user_id uuid;
ALTER TABLE entity_dictionary ADD COLUMN user_id uuid;

-- ── 2. Backfill with founder user ID ───────────────────────

UPDATE notes             SET user_id = current_setting('app.founder_id')::uuid WHERE user_id IS NULL;
UPDATE links             SET user_id = current_setting('app.founder_id')::uuid WHERE user_id IS NULL;
UPDATE clusters          SET user_id = current_setting('app.founder_id')::uuid WHERE user_id IS NULL;
UPDATE enrichment_log    SET user_id = current_setting('app.founder_id')::uuid WHERE user_id IS NULL;
UPDATE capture_profiles  SET user_id = current_setting('app.founder_id')::uuid WHERE user_id IS NULL;
UPDATE processed_updates SET user_id = current_setting('app.founder_id')::uuid WHERE user_id IS NULL;
UPDATE entity_dictionary SET user_id = current_setting('app.founder_id')::uuid WHERE user_id IS NULL;

-- ── 3. Set NOT NULL ────────────────────────────────────────

ALTER TABLE notes             ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE links             ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE clusters          ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE enrichment_log    ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE capture_profiles  ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE processed_updates ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE entity_dictionary ALTER COLUMN user_id SET NOT NULL;

-- ── 4. Add FK constraints ──────────────────────────────────

ALTER TABLE notes             ADD CONSTRAINT notes_user_id_fk             FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE links             ADD CONSTRAINT links_user_id_fk             FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE clusters          ADD CONSTRAINT clusters_user_id_fk          FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE enrichment_log    ADD CONSTRAINT enrichment_log_user_id_fk    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE capture_profiles  ADD CONSTRAINT capture_profiles_user_id_fk  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE processed_updates ADD CONSTRAINT processed_updates_user_id_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE entity_dictionary ADD CONSTRAINT entity_dictionary_user_id_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── 5. Add indexes ─────────────────────────────────────────

CREATE INDEX notes_user_created_idx ON notes (user_id, created_at DESC);
CREATE INDEX clusters_user_resolution_idx ON clusters (user_id, resolution);

-- ── 6. Update UNIQUE constraints ───────────────────────────

-- capture_profiles: (name) → (user_id, name)
ALTER TABLE capture_profiles DROP CONSTRAINT IF EXISTS capture_profiles_name_key;
ALTER TABLE capture_profiles ADD CONSTRAINT capture_profiles_user_name_key UNIQUE (user_id, name);

-- entity_dictionary: (name, type) → (user_id, name, type)
ALTER TABLE entity_dictionary DROP CONSTRAINT IF EXISTS entity_dictionary_name_type_key;
ALTER TABLE entity_dictionary ADD CONSTRAINT entity_dictionary_user_name_type_key UNIQUE (user_id, name, type);
