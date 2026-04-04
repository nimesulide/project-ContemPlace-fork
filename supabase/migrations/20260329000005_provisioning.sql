-- ============================================================
-- USER PROVISIONING TRIGGER
-- Auto-creates user_profiles and capture_profiles on signup.
-- SECURITY DEFINER: runs with table owner permissions to
-- write to public tables regardless of RLS.
-- Idempotent: ON CONFLICT DO NOTHING on both inserts.
-- refs #002-multi-tenant-mvp
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Create user profile
  INSERT INTO public.user_profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Seed default capture profile
  INSERT INTO public.capture_profiles (user_id, name, capture_voice)
  VALUES (
    NEW.id,
    'default',
    '## Your capture style

**Title**: A claim or insight when one is present. A good title lets you scan a list and know what the fragment says without opening it. If the input doesn''t contain a claim, use a descriptive phrase. Never a topic label. Use the user''s vocabulary in titles, not academic equivalents or genre classifications.

**Body**: Use the user''s own words. Every sentence must be traceable to the input. Enough to land the idea, no more — shorter is better than padded, but completeness beats brevity when the idea requires it. Never compress, never add inferred meanings, never add a concluding sentence that summarizes what the user''s words already showed.'
  )
  ON CONFLICT (user_id, name) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Create trigger on auth.users
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
