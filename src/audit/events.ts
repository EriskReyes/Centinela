/**
 * Fase 5 — Tipos y hashing del registro de auditoría.
 *
 * Cada entrada guarda el hash de su propio contenido y el hash del eslabón
 * anterior (cadena de hashes): alterar cualquier campo rompe la cadena y la
 * verificación lo detecta. El registro es append-only por diseño.
 */
import { createHash } from 'node:crypto';
import type { ActionStatus } from '../domain/action.ts';

export const AUDIT_EVENT_TYPES = [
  'action_proposed',
  'engine_decision',
  'action_executed',
  'signature_requested',
  'action_signed',
  'signature_failed',
  'action_expired',
  'policy_updated',
  'credential_revoked',
  'anchor_failed',
  'access_denied',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** Un hecho ocurrido en el sistema, tal y como lo registra el logger. */
export interface AuditEvent {
  eventType: AuditEventType;
  actionId: string;
  /** Quién actuó: el agente, 'rules-engine', la llave WebAuthn, el conector o 'system'. */
  actor: string;
  decision?: string;
  statusBefore?: ActionStatus;
  statusAfter?: ActionStatus;
  reason?: string;
  policyVersion?: number;
  at: Date;
}

/** Entrada ya encadenada y almacenada. */
export interface AuditEntry extends AuditEvent {
  id: string;
  /** Posición en el registro: 1, 2, 3… sin huecos. */
  seq: number;
  /** SHA-256 del contenido de la entrada. */
  contentHash: string;
  /** Hash del eslabón anterior (la primera entrada encadena con GENESIS_HASH). */
  prevHash: string;
}

export const GENESIS_HASH = createHash('sha256').update('centinela-genesis').digest('base64url');

/** Serialización canónica (claves en orden fijo) → SHA-256 en base64url. */
export function entryContentHash(entry: Omit<AuditEntry, 'contentHash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        seq: entry.seq,
        eventType: entry.eventType,
        actionId: entry.actionId,
        actor: entry.actor,
        decision: entry.decision ?? null,
        statusBefore: entry.statusBefore ?? null,
        statusAfter: entry.statusAfter ?? null,
        reason: entry.reason ?? null,
        policyVersion: entry.policyVersion ?? null,
        at: entry.at.toISOString(),
      }),
    )
    .digest('base64url');
}

/** Hash del eslabón: encadena el contenido con el eslabón anterior. */
export function linkHash(contentHash: string, prevHash: string): string {
  return createHash('sha256').update(`${contentHash}${prevHash}`).digest('base64url');
}
