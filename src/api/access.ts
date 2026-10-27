/**
 * Fase 8 — Control de acceso: dos identidades que nunca se mezclan.
 *
 *  - agente: un token por agente de IA. Solo puede PROPONER acciones
 *    (POST /api/actions) y consultar las suyas (GET /api/actions/:id).
 *    El token fija su agentId: un agente no puede proponer en nombre de otro.
 *  - admin: el panel y la página de firma. Política, llaves, cola de
 *    pendientes y auditoría. El agente NUNCA tiene este token.
 *
 * Sin esta separación la firma WebAuthn no protege nada: el agente podría
 * subir los límites de la política, registrar su propia llave o revocar las
 * de los humanos usando la misma API con la que propone pagos.
 *
 * Fail-closed: toda ruta bajo /api es de admin salvo las dos del agente.
 * Una ruta nueva nace protegida aunque nadie se acuerde de protegerla.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type express from 'express';

export interface AccessConfig {
  adminToken: string;
  /** agentId → token. */
  agentTokens: Record<string, string>;
}

export type Principal = { kind: 'admin' } | { kind: 'agent'; agentId: string };

export const MIN_TOKEN_LENGTH = 24;

/** Comparación en tiempo constante; el SHA-256 iguala longitudes para que tampoco filtren. */
function sameToken(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Token aleatorio de 256 bits (base64url, 43 caracteres). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Lee `agente-compras=tok1,agente-viajes=tok2` (formato de CENTINELA_AGENT_TOKENS). */
export function parseAgentTokens(raw: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at <= 0 || at === pair.length - 1) {
      throw new Error(`CENTINELA_AGENT_TOKENS: '${pair.split('=')[0]}' debe tener la forma agentId=token`);
    }
    const agentId = pair.slice(0, at).trim();
    if (tokens[agentId] !== undefined) {
      throw new Error(`CENTINELA_AGENT_TOKENS: el agente '${agentId}' aparece dos veces`);
    }
    tokens[agentId] = pair.slice(at + 1).trim();
  }
  return tokens;
}

/** Rechaza configuraciones peligrosas antes de arrancar: tokens cortos o compartidos. */
export function validateAccessConfig(config: AccessConfig): void {
  if (config.adminToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`el token de admin debe tener al menos ${MIN_TOKEN_LENGTH} caracteres`);
  }
  const seen = [config.adminToken];
  for (const [agentId, token] of Object.entries(config.agentTokens)) {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`el token del agente '${agentId}' debe tener al menos ${MIN_TOKEN_LENGTH} caracteres`);
    }
    if (seen.some((other) => sameToken(token, other))) {
      throw new Error(`el token del agente '${agentId}' se repite: cada identidad necesita el suyo`);
    }
    seen.push(token);
  }
}

/** Quién llama, según el header Authorization: Bearer <token>; null si nadie conocido. */
export function resolvePrincipal(config: AccessConfig, header: string | undefined): Principal | null {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    return null;
  }
  // Se comparan TODOS los tokens: el tiempo no revela cuál coincidió.
  let found: Principal | null = sameToken(token, config.adminToken) ? { kind: 'admin' } : null;
  for (const [agentId, candidate] of Object.entries(config.agentTokens)) {
    if (sameToken(token, candidate)) {
      found = { kind: 'agent', agentId };
    }
  }
  return found;
}

/** Las únicas rutas (relativas a /api) que un agente puede tocar. */
export function agentMayAccess(method: string, path: string): boolean {
  if (method === 'POST' && path === '/actions') {
    return true;
  }
  return method === 'GET' && /^\/actions\/[^/]+$/.test(path) && path !== '/actions/pending';
}

export function principalOf(res: express.Response): Principal {
  return res.locals.principal as Principal;
}

/**
 * Middleware para /api: 401 sin token válido, 403 si un agente sale de sus
 * dos rutas. `onAgentDenied` permite auditar el intento (señal de un agente
 * comprometido o desbocado).
 */
export function requireAccess(
  config: AccessConfig,
  onAgentDenied?: (agentId: string, req: express.Request) => Promise<void>,
): express.RequestHandler {
  return async (req, res, next) => {
    const principal = resolvePrincipal(config, req.get('Authorization'));
    if (principal === null) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'falta un token válido (Authorization: Bearer <token>)' });
      return;
    }
    if (principal.kind === 'agent' && !agentMayAccess(req.method, req.path)) {
      try {
        await onAgentDenied?.(principal.agentId, req);
      } catch (err) {
        next(err);
        return;
      }
      res.status(403).json({ error: `el agente '${principal.agentId}' no tiene acceso a ${req.method} /api${req.path}` });
      return;
    }
    res.locals.principal = principal;
    next();
  };
}
