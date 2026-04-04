import { createClient } from '@supabase/supabase-js';
import type { Env } from './types';
import type { Config } from './config';

/**
 * Constant-time string comparison.
 * Uses crypto.subtle.timingSafeEqual (Workers runtime) with a fallback
 * to a manual constant-time loop (for Node test environments).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  // crypto.subtle.timingSafeEqual exists in Workers but not in Node < 20
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof (crypto.subtle as unknown as Record<string, unknown>)['timingSafeEqual'] === 'function') {
    return crypto.subtle.timingSafeEqual(bufA, bufB);
  }

  // Fallback: manual constant-time comparison
  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}

/**
 * Check whether the request carries a valid static Bearer token.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function isStaticTokenRequest(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  if (!token) return false;
  return timingSafeEqual(token, env.MCP_API_KEY);
}

/**
 * Validate auth and return an error Response if invalid, or null if OK.
 * Uses constant-time comparison internally.
 */
export function validateAuth(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const token = authHeader.slice(7);
  if (!token || !timingSafeEqual(token, env.MCP_API_KEY)) {
    console.warn(JSON.stringify({ event: 'auth_failed', reason: 'invalid_token' }));
    return new Response('Forbidden', { status: 403 });
  }
  return null;
}

/**
 * Resolve a `cp_` prefixed per-user API key to a userId.
 * SHA-256 hashes the provided key and looks up user_profiles.mcp_api_key_hash.
 */
export async function resolvePerUserApiKey(
  token: string,
  config: Config,
): Promise<string | null> {
  if (!token.startsWith('cp_')) return null;

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const db = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const { data, error } = await db
    .from('user_profiles')
    .select('user_id')
    .eq('mcp_api_key_hash', hashHex)
    .single();

  if (error || !data) return null;
  return (data as { user_id: string }).user_id;
}
