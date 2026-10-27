/**
 * Fase 4 — El reto de firma.
 *
 * El reto WebAuthn NO es aleatorio: es el hash SHA-256 de los datos exactos de
 * la acción más la decisión pedida. Firmar el reto = firmar "apruebo ESTA
 * acción, con ESTE importe, ESTE destino y ESTA justificación". Firmar otra
 * cosa es imposible: cualquier cambio en los datos produce otro hash.
 */
import { createHash } from 'node:crypto';
import type { AgentAction } from '../domain/action.ts';

export type HumanDecision = 'approve' | 'reject';

/**
 * Serialización canónica: claves en orden fijo y campos críticos completos.
 * Incluye las firmas parciales YA recibidas (cuarto ojos): así el reto de la
 * segunda firma queda ligado al progreso real y una firma antigua no puede
 * reutilizarse en otro contexto de quórum.
 */
export function buildSigningPayload(action: AgentAction, decision: HumanDecision): string {
  return JSON.stringify({
    actionId: action.id,
    actionType: action.actionType,
    amountMinor: action.amountMinor ?? null,
    currency: action.currency,
    destination: action.destination,
    justification: action.justification,
    decision,
    priorSignatures: [...(action.signatures ?? []).map((s) => s.keyId)].sort(),
  });
}

export function challengeForAction(action: AgentAction, decision: HumanDecision): string {
  return createHash('sha256').update(buildSigningPayload(action, decision)).digest('base64url');
}

/**
 * Huella corta del reto para la verificación humana entre DOS canales.
 *
 * 16 caracteres hex (64 bits de entropía): suficiente para descartar fuerza
 * bruta práctica, con formato legible en 4 bloques. La huella sale del reto
 * real que se va a firmar, no de la UI; en /firmar se TECLEA, no se compara
 * solo visualmente.
 */
export function challengeFingerprint(challenge: string): string {
  const hex = Buffer.from(challenge, 'base64url').toString('hex').slice(0, 16);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}
