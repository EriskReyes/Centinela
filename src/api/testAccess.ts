/**
 * Fase 8 — Tokens de prueba compartidos por las suites que levantan la API.
 *
 * `authedFetch` llama como lo haría cada actor real: POST /api/actions con el
 * token del agente y todo lo demás con el del admin (panel y página de firma).
 * Un header Authorization explícito gana: así se prueban los rechazos.
 */
import type { AccessConfig } from './access.ts';

export const TEST_AGENT_ID = 'agente-compras';
export const TEST_ADMIN_TOKEN = 'admin-token-de-pruebas-0123456789';
export const TEST_AGENT_TOKEN = 'agente-token-de-pruebas-0123456789';
export const TEST_OTHER_AGENT_ID = 'agente-viajes';
export const TEST_OTHER_AGENT_TOKEN = 'otro-agente-token-pruebas-0123456789';

export const TEST_ACCESS: AccessConfig = {
  adminToken: TEST_ADMIN_TOKEN,
  agentTokens: { [TEST_AGENT_ID]: TEST_AGENT_TOKEN, [TEST_OTHER_AGENT_ID]: TEST_OTHER_AGENT_TOKEN },
};

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const isAgentCall = method === 'POST' && new URL(url).pathname === '/api/actions';
  return fetch(url, {
    ...init,
    headers: {
      ...bearer(isAgentCall ? TEST_AGENT_TOKEN : TEST_ADMIN_TOKEN),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
}
