/**
 * Idempotencia en DOS capas.
 *
 * 1. Clave explícita: el agente manda `Idempotency-Key` — mecanismo principal,
 *    control total (dos acciones idénticas intencionadas usan claves distintas).
 * 2. Red de seguridad: sin header, la clave se DERIVA del contenido exacto de
 *    la acción + una ventana de tiempo (por defecto 60 s). Mismo payload dentro
 *    de la misma ventana = misma clave = el índice único de Mongo rechaza el
 *    duplicado y la API devuelve la acción original con `replayed: true`.
 *
 * Limitación honesta: un reintento fuera de la ventana sigue creando una
 * acción nueva; para reintentos tardíos la clave explícita es el cierre.
 */
import { createHash } from 'node:crypto';

export interface DerivableProposal {
  agentId?: unknown;
  actionType?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
  destination?: unknown;
  justification?: unknown;
}

export function deriveIdempotencyKey(body: DerivableProposal, now: Date, windowSeconds: number): string {
  const bucket = Math.floor(now.getTime() / (windowSeconds * 1000));
  return createHash('sha256')
    .update(
      JSON.stringify({
        agentId: body.agentId ?? null,
        actionType: body.actionType ?? null,
        amountMinor: body.amountMinor ?? null,
        currency: body.currency ?? null,
        destination: body.destination ?? null,
        justification: body.justification ?? null,
        bucket,
      }),
    )
    .digest('hex');
}
