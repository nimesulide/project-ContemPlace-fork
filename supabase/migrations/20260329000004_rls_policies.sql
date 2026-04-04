-- ============================================================
-- RLS POLICIES: Replace deny-all with user-scoped policies
-- Service role key bypasses RLS entirely. These policies are
-- defense-in-depth for the anon key / authenticated users.
-- refs #002-multi-tenant-mvp
-- ============================================================

-- ── Drop existing deny-all policies ────────────────────────

DROP POLICY IF EXISTS "deny all" ON notes;
DROP POLICY IF EXISTS "deny all" ON links;
DROP POLICY IF EXISTS "deny all" ON enrichment_log;
DROP POLICY IF EXISTS "deny all" ON capture_profiles;
DROP POLICY IF EXISTS "deny all" ON processed_updates;
DROP POLICY IF EXISTS "deny all" ON clusters;
DROP POLICY IF EXISTS "Deny all access to entity_dictionary" ON entity_dictionary;

-- ── notes ──────────────────────────────────────────────────

CREATE POLICY "Users can select own notes" ON notes
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own notes" ON notes
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own notes" ON notes
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Users can delete own notes" ON notes
  FOR DELETE USING (user_id = auth.uid());

-- ── links ──────────────────────────────────────────────────

CREATE POLICY "Users can select own links" ON links
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own links" ON links
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own links" ON links
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Users can delete own links" ON links
  FOR DELETE USING (user_id = auth.uid());

-- ── clusters ───────────────────────────────────────────────

CREATE POLICY "Users can select own clusters" ON clusters
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own clusters" ON clusters
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own clusters" ON clusters
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Users can delete own clusters" ON clusters
  FOR DELETE USING (user_id = auth.uid());

-- ── enrichment_log ─────────────────────────────────────────

CREATE POLICY "Users can select own enrichment_log" ON enrichment_log
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own enrichment_log" ON enrichment_log
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- ── capture_profiles ───────────────────────────────────────

CREATE POLICY "Users can select own capture_profiles" ON capture_profiles
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can update own capture_profiles" ON capture_profiles
  FOR UPDATE USING (user_id = auth.uid());

-- ── processed_updates ──────────────────────────────────────

CREATE POLICY "Users can select own processed_updates" ON processed_updates
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own processed_updates" ON processed_updates
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- ── entity_dictionary ──────────────────────────────────────

CREATE POLICY "Users can select own entity_dictionary" ON entity_dictionary
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own entity_dictionary" ON entity_dictionary
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own entity_dictionary" ON entity_dictionary
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Users can delete own entity_dictionary" ON entity_dictionary
  FOR DELETE USING (user_id = auth.uid());
