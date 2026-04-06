import { loadConfig } from './config';
import { validateAuth, validateJwt } from './auth';
import { createSupabaseClient, fetchStats, fetchClusters, fetchClusterDetail, fetchRecent, fetchUserProfile, regenerateApiKey, createTelegramLinkToken, disconnectTelegram } from './db';
import { fetchBackupRecency } from './github';
import type { Env } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders(config.corsOrigin) });
    }

    // ── Auth: JWT first, static key fallback ───────────────────────────────────
    let userId: string | null = null;

    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Try JWT validation first
      const jwtResult = await validateJwt(token, config.supabaseJwtSecret);
      if (jwtResult) {
        userId = jwtResult.userId;
      } else {
        // Fall back to static API key (temporary backward compatibility)
        const staticAuthError = validateAuth(request, config.dashboardApiKey);
        if (staticAuthError) return withCors(staticAuthError, config.corsOrigin);
        userId = 'static-key';
      }
    } else {
      return withCors(new Response('Unauthorized', { status: 401 }), config.corsOrigin);
    }

    const db = createSupabaseClient(config);

    try {
      // ── GET routes ─────────────────────────────────────────────────────────────
      if (request.method === 'GET') {
        if (path === '/stats') {
          const stats = await fetchStats(db, userId);
          const backupLastCommit = await fetchBackupRecency(config.backupRepo, config.githubBackupPat);
          return jsonResponse({ ...stats, backup_last_commit: backupLastCommit }, config.corsOrigin);
        }

        if (path === '/clusters') {
          const resolution = parseFloat(url.searchParams.get('resolution') ?? '1.0');
          if (isNaN(resolution)) return withCors(new Response('Invalid resolution', { status: 400 }), config.corsOrigin);
          const result = await fetchClusters(db, resolution, userId);
          return jsonResponse({ resolution, ...result }, config.corsOrigin);
        }

        if (path === '/clusters/detail') {
          const idsParam = url.searchParams.get('note_ids') ?? '';
          const noteIds = idsParam.split(',').filter(Boolean);
          if (noteIds.length === 0) return withCors(new Response('note_ids required', { status: 400 }), config.corsOrigin);
          if (noteIds.length > 50) return withCors(new Response('Maximum 50 note_ids', { status: 400 }), config.corsOrigin);
          if (!noteIds.every(id => UUID_RE.test(id))) return withCors(new Response('Invalid UUID format', { status: 400 }), config.corsOrigin);
          const result = await fetchClusterDetail(db, noteIds, userId);
          return jsonResponse(result, config.corsOrigin);
        }

        if (path === '/recent') {
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '15', 10) || 15, 1), 50);
          const notes = await fetchRecent(db, limit, userId);
          return jsonResponse(notes, config.corsOrigin);
        }

        if (path === '/settings/profile') {
          if (userId === 'static-key') return withCors(new Response('JWT auth required', { status: 403 }), config.corsOrigin);
          const profile = await fetchUserProfile(db, userId, config.mcpEndpoint);
          if (!profile) return withCors(new Response('Profile not found', { status: 404 }), config.corsOrigin);
          return jsonResponse(profile, config.corsOrigin);
        }

        return withCors(new Response('Not Found', { status: 404 }), config.corsOrigin);
      }

      // ── POST routes ────────────────────────────────────────────────────────────
      if (request.method === 'POST') {
        if (path === '/capture') {
          if (!env.CAPTURE_SERVICE) {
            return withCors(new Response('Capture service not available', { status: 503 }), config.corsOrigin);
          }

          let body: { text?: string; source?: string };
          try {
            body = await request.json() as { text?: string; source?: string };
          } catch {
            return withCors(new Response('Invalid JSON body', { status: 400 }), config.corsOrigin);
          }

          const text = body.text;
          if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return withCors(new Response('text is required and must be non-empty', { status: 400 }), config.corsOrigin);
          }

          const source = body.source || 'web';
          const result = await env.CAPTURE_SERVICE.capture(text, source, { userId });
          return jsonResponse(result, config.corsOrigin);
        }

        if (path === '/settings/regenerate-key') {
          if (userId === 'static-key') return withCors(new Response('JWT auth required', { status: 403 }), config.corsOrigin);
          const rawKey = await regenerateApiKey(db, userId);
          return jsonResponse({
            api_key: rawKey,
            message: 'This key will only be shown once. Store it securely.',
          }, config.corsOrigin);
        }

        if (path === '/settings/telegram-link') {
          if (userId === 'static-key') return withCors(new Response('JWT auth required', { status: 403 }), config.corsOrigin);
          const token = await createTelegramLinkToken(db, userId);
          const botUsername = config.telegramBotUsername;
          return jsonResponse({
            deep_link: `https://t.me/${botUsername}?start=${token}`,
            expires_in_minutes: 15,
          }, config.corsOrigin);
        }

        return withCors(new Response('Not Found', { status: 404 }), config.corsOrigin);
      }

      // ── DELETE routes ───────────────────────────────────────────────────────────
      if (request.method === 'DELETE') {
        if (path === '/settings/telegram') {
          if (userId === 'static-key') return withCors(new Response('JWT auth required', { status: 403 }), config.corsOrigin);
          await disconnectTelegram(db, userId);
          return withCors(new Response(null, { status: 204 }), config.corsOrigin);
        }

        return withCors(new Response('Not Found', { status: 404 }), config.corsOrigin);
      }

      // ── Unsupported methods ────────────────────────────────────────────────────
      return withCors(new Response('Method Not Allowed', { status: 405 }), config.corsOrigin);
    } catch (err) {
      console.error(JSON.stringify({ event: 'dashboard_api_error', error: String(err), path }));
      return withCors(new Response('Internal Server Error', { status: 500 }), config.corsOrigin);
    }
  },
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(data: unknown, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
  });
}
