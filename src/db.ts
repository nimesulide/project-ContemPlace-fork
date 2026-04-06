import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';

export type SupabaseClientType = SupabaseClient;

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

/**
 * Attempt to claim this update_id. Returns true if new, false if duplicate.
 * Throws on unexpected DB errors.
 */
export async function tryClaimUpdate(
  db: SupabaseClient,
  updateId: number,
): Promise<boolean> {
  const { error } = await db
    .from('processed_updates')
    .insert({ update_id: updateId });

  if (!error) return true;

  if (error.code === '23505') {
    return false; // duplicate — already processed
  }

  // Unexpected error — log but allow processing to continue
  console.error(JSON.stringify({
    event: 'dedup_insert_error',
    error: error.message,
    code: error.code,
    update_id: updateId,
  }));
  return true;
}

/**
 * Look up a Telegram chat_id in the telegram_connections table.
 * Returns the user_id if connected, null otherwise.
 */
export async function lookupTelegramUser(
  db: SupabaseClient,
  chatId: number,
): Promise<string | null> {
  const { data, error } = await db
    .from('telegram_connections')
    .select('user_id')
    .eq('chat_id', chatId)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({
      event: 'telegram_user_lookup_error',
      error: error.message,
      code: error.code,
      chatId,
    }));
    return null;
  }

  return data?.user_id ?? null;
}

/**
 * Validate a deep-link token from telegram_link_tokens.
 * Checks that the token exists and has not expired.
 * Returns { userId } if valid, null otherwise.
 */
export async function validateLinkToken(
  db: SupabaseClient,
  token: string,
): Promise<{ userId: string } | null> {
  const { data, error } = await db
    .from('telegram_link_tokens')
    .select('user_id, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({
      event: 'link_token_validate_error',
      error: error.message,
      code: error.code,
    }));
    return null;
  }

  if (!data) return null;

  // Check expiry
  if (new Date(data.expires_at) < new Date()) {
    return null;
  }

  return { userId: data.user_id };
}

/**
 * Insert a row into telegram_connections, linking a user to a Telegram chat.
 * Throws on unique constraint violation (chat already connected).
 */
export async function createTelegramConnection(
  db: SupabaseClient,
  userId: string,
  chatId: number,
): Promise<void> {
  const { error } = await db
    .from('telegram_connections')
    .insert({
      user_id: userId,
      chat_id: chatId,
      connected_at: new Date().toISOString(),
    });

  if (error) {
    throw error;
  }
}

/**
 * Delete a used link token so it cannot be reused.
 */
export async function deleteLinkToken(
  db: SupabaseClient,
  token: string,
): Promise<void> {
  const { error } = await db
    .from('telegram_link_tokens')
    .delete()
    .eq('token', token);

  if (error) {
    console.error(JSON.stringify({
      event: 'link_token_delete_error',
      error: error.message,
      code: error.code,
    }));
  }
}
