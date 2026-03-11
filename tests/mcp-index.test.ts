/**
 * Tests for the MCP HTTP wrapper (mcp/src/index.ts default export).
 * Auth, routing, and CORS only — JSON-RPC dispatch is tested in mcp-dispatch.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../mcp/src/tools', () => ({
  TOOL_DEFINITIONS: [
    { name: 'search_notes', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ],
  handleSearchNotes: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }),
  handleGetNote: vi.fn(),
  handleListRecent: vi.fn(),
  handleGetRelated: vi.fn(),
  handleCaptureNote: vi.fn(),
  handleListUnmatchedTags: vi.fn(),
  handlePromoteConcept: vi.fn(),
  handleSearchChunks: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../mcp/src/embed', () => ({
  createOpenAIClient: vi.fn().mockReturnValue({}),
  embedText: vi.fn(),
  buildEmbeddingInput: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import handler from '../mcp/src/index';

const VALID_API_KEY = 'test-mcp-api-key';

const MOCK_ENV = {
  MCP_API_KEY: VALID_API_KEY,
  OPENROUTER_API_KEY: 'or-key',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  CAPTURE_MODEL: 'anthropic/claude-haiku-4-5',
  EMBED_MODEL: 'openai/text-embedding-3-small',
  MATCH_THRESHOLD: '0.60',
};

function authHeaders(key = VALID_API_KEY): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  };
}

function rpcBody(method: string, id: unknown = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', method, id });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP HTTP wrapper', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('CORS preflight', () => {
    it('returns 204 for OPTIONS request', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', { method: 'OPTIONS' }),
        MOCK_ENV,
      );
      expect(res.status).toBe(204);
    });

    it('sets Access-Control-Allow-Origin: * on preflight', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', { method: 'OPTIONS' }),
        MOCK_ENV,
      );
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('sets correct Allow-Methods header', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', { method: 'OPTIONS' }),
        MOCK_ENV,
      );
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('routing', () => {
    it('returns 404 for GET /mcp', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', { method: 'GET' }),
        MOCK_ENV,
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 for POST to an unknown path', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/other', { method: 'POST', headers: authHeaders(), body: '{}' }),
        MOCK_ENV,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
        MOCK_ENV,
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when token is wrong', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', {
          method: 'POST',
          headers: authHeaders('wrong-key'),
          body: rpcBody('initialize'),
        }),
        MOCK_ENV,
      );
      expect(res.status).toBe(403);
    });

    it('allows request through with correct token', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', {
          method: 'POST',
          headers: authHeaders(),
          body: rpcBody('initialize'),
        }),
        MOCK_ENV,
      );
      expect(res.status).toBe(200);
    });
  });

  describe('delegates to handleMcpRequest after auth', () => {
    it('returns valid JSON-RPC response for an authenticated request', async () => {
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', {
          method: 'POST',
          headers: authHeaders(),
          body: rpcBody('initialize'),
        }),
        MOCK_ENV,
      );
      const body = await res.json() as Record<string, unknown>;
      expect(body['jsonrpc']).toBe('2.0');
      expect(body['result']).toBeDefined();
    });
  });
});
