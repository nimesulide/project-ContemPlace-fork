import { describe, it, expect, vi } from 'vitest';
import { validateAuth, isStaticTokenRequest } from '../mcp/src/auth';
import type { Env } from '../mcp/src/types';

const VALID_KEY = 'test-api-key-12345';
const MOCK_ENV = { MCP_API_KEY: VALID_KEY } as unknown as Env;

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new Request('https://example.com/mcp', { method: 'POST', headers });
}

describe('validateAuth', () => {
  it('returns null when Authorization header is a valid Bearer token', () => {
    const result = validateAuth(makeRequest(`Bearer ${VALID_KEY}`), MOCK_ENV);
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization header is missing', () => {
    const result = validateAuth(makeRequest(), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 when Authorization header does not start with "Bearer "', () => {
    const result = validateAuth(makeRequest(`Token ${VALID_KEY}`), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 for "Bearer" with no trailing space', () => {
    const result = validateAuth(makeRequest('Bearer'), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 403 when token does not match MCP_API_KEY', () => {
    const result = validateAuth(makeRequest('Bearer wrong-token'), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('returns 401 when header value is "Bearer" with no token (trailing space trimmed)', () => {
    const result = validateAuth(makeRequest('Bearer '), MOCK_ENV);
    expect(result).not.toBeNull();
    // Fetch API trims header values, so "Bearer " → "Bearer" → fails startsWith check → 401
    // But if not trimmed, slice(7) is empty → 403. Both are acceptable.
    expect([401, 403]).toContain(result!.status);
  });

  it('logs a warning on token mismatch', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest('Bearer wrong-token'), MOCK_ENV);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('does not log a warning on successful auth', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest(`Bearer ${VALID_KEY}`), MOCK_ENV);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('isStaticTokenRequest', () => {
  it('returns true when Bearer token matches MCP_API_KEY', () => {
    expect(isStaticTokenRequest(makeRequest(`Bearer ${VALID_KEY}`), MOCK_ENV)).toBe(true);
  });

  it('returns false when token does not match', () => {
    expect(isStaticTokenRequest(makeRequest('Bearer wrong-token'), MOCK_ENV)).toBe(false);
  });

  it('returns false when token has different length', () => {
    expect(isStaticTokenRequest(makeRequest('Bearer x'), MOCK_ENV)).toBe(false);
  });

  it('returns false when Authorization header is missing', () => {
    expect(isStaticTokenRequest(makeRequest(), MOCK_ENV)).toBe(false);
  });

  it('returns false for non-Bearer scheme', () => {
    expect(isStaticTokenRequest(makeRequest(`Token ${VALID_KEY}`), MOCK_ENV)).toBe(false);
  });
});
