/**
 * Fase 5 — Servicio del registro de auditoría.
 *
 * append() calcula la secuencia, el hash del contenido y el eslabón con la
 * entrada anterior; verify() recorre TODO el registro recomputando los hashes:
 * cualquier alteración (de campos o de hashes) rompe la cadena y se informa
 * la primera posición rota.
 *
 * Anclaje externo: cada N entradas se publica la cabeza fuera de Mongo. Un
 * fallo de anclaje queda registrado en DOS sitios: como evento anchor_failed
 * dentro de la cadena (diagnóstico) y en el diario externo (donde un admin de
 * Mongo no llega). Y como tercera señal, el "silencio": anchorState() marca
 * stale si hace demasiado tiempo que no hay un anclaje EXTERNO exitoso o si
 * la cadena avanzó más de lo previsto sin anclar — un admin de Mongo puede
 * borrar eventos, pero no puede fabricar un anclaje reciente en el diario.
 */
import { randomUUID } from 'node:crypto';
import { entryContentHash, GENESIS_HASH, linkHash, type AuditEntry, type AuditEvent } from './events.ts';
import type { AuditListFilter, AuditRepository } from './repository.ts';
import {
  defaultAnchorConfig,
  type AnchorFailureRecord,
  type AnchorRecord,
  type AnchorSink,
  type JournalEntry,
} from './anchor.ts';

export interface VerifyResult {
  ok: boolean;
  total: number;
  /** seq del primer eslabón roto; null si la cadena está íntegra. */
  firstBreak: number | null;
}

export interface AnchorState {
  head: { seq: number; hash: string; count: number } | null;
  /** Último anclaje EXITOSO publicado fuera de Mongo. */
  lastAnchor: AnchorRecord | null;
  /** Último intento (éxito o fallo) registrado en el diario externo. */
  lastAttempt: JournalEntry | null;
  /** Silencio prolongado: la copia externa se está quedando atrás. */
  stale: boolean;
  staleReason?: string;
  stalenessMinutes: number;
}

export interface AuditService {
  append(event: AuditEvent): Promise<AuditEntry>;
  list(filter: AuditListFilter): Promise<AuditEntry[]>;
  timeline(actionId: string): Promise<AuditEntry[]>;
  verify(): Promise<VerifyResult>;
  /** Cabeza actual de la cadena + estado del anclaje externo (para el panel). */
  anchorState(): Promise<AnchorState>;
}

export function createAuditService(deps: {
  repository: AuditRepository;
  idFactory?: () => string;
  /** Anclar cada N entradas (por defecto 50; 0 lo desactiva). */
  anchorEvery?: number;
  anchorSink?: AnchorSink;
  /** Registra los FALLOS en el diario externo. */
  journalFailure?: (failure: AnchorFailureRecord) => Promise<void>;
  /** Lee el último intento (éxito o fallo) del diario externo. */
  readJournal?: () => Promise<JournalEntry | null>;
  /** Lee el último anclaje EXITOSO del diario externo. */
  readLastAnchor?: () => Promise<AnchorRecord | null>;
  now?: () => Date;
  /** Umbral de silencio: minutos sin anclaje externo exitoso (por defecto 60). */
  anchorStalenessMinutes?: number;
}): AuditService {
  const idFactory = deps.idFactory ?? randomUUID;
  const anchorEvery = deps.anchorEvery ?? 50;
  const anchorSink = deps.anchorSink ?? defaultAnchorConfig().sinks;
  const journalFailure = deps.journalFailure ?? (() => Promise.resolve());
  const readJournal = deps.readJournal ?? (() => Promise.resolve(null));
  const readLastAnchor = deps.readLastAnchor ?? (() => Promise.resolve(null));
  const now = deps.now ?? (() => new Date());
  const stalenessMinutes = deps.anchorStalenessMinutes ?? 60;

  /** Escribe una entrada (secuencia + hashes + inserción) SIN anclar: evita recursión. */
  const writeEntry = async (event: AuditEvent): Promise<AuditEntry> => {
    const seq = await deps.repository.nextSeq();
    const previous = await deps.repository.latest();
    const prevHash = previous === null ? GENESIS_HASH : linkHash(previous.contentHash, previous.prevHash);
    const base: Omit<AuditEntry, 'contentHash'> = { ...event, id: idFactory(), seq, prevHash };
    const entry: AuditEntry = { ...base, contentHash: entryContentHash(base) };
    await deps.repository.insert(entry);
    return entry;
  };

  return {
    async append(event: AuditEvent): Promise<AuditEntry> {
      const entry = await writeEntry(event);

      // Anclaje externo: publica la cabeza fuera de Mongo cada N entradas.
      if (anchorEvery > 0 && entry.seq % anchorEvery === 0) {
        const anchor: AnchorRecord = {
          at: now().toISOString(),
          seq: entry.seq,
          hash: linkHash(entry.contentHash, entry.prevHash),
          count: entry.seq,
        };
        try {
          await anchorSink(anchor);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const httpStatus = /HTTP (\d+)/.exec(message)?.[1];
          const failure: AnchorFailureRecord = {
            kind: 'failure',
            at: now().toISOString(),
            error: message,
            ...(httpStatus !== undefined ? { httpStatus: Number(httpStatus) } : {}),
          };
          // 1) Diario externo: un admin de Mongo no llega hasta aquí.
          try {
            await journalFailure(failure);
          } catch (journalErr) {
            console.error('[centinela] ni el diario externo pudo registrar el fallo:', journalErr);
          }
          // 2) Evento en la propia cadena: diagnóstico inmediato en el panel.
          try {
            await writeEntry({
              eventType: 'anchor_failed',
              actionId: 'cadena',
              actor: 'system',
              decision: 'rejected',
              reason: `anclaje externo fallido: ${message}`,
              at: now(),
            });
          } catch (auditErr) {
            console.error('[centinela] no se pudo auditar el fallo de anclaje:', auditErr);
          }
        }
      }
      return entry;
    },

    async list(filter: AuditListFilter): Promise<AuditEntry[]> {
      return deps.repository.list(filter);
    },

    async timeline(actionId: string): Promise<AuditEntry[]> {
      return deps.repository.findByAction(actionId);
    },

    async verify(): Promise<VerifyResult> {
      const entries = await deps.repository.allSorted();
      let previousHash = GENESIS_HASH;
      for (const [index, entry] of entries.entries()) {
        const expectedSeq = index + 1;
        if (entry.seq !== expectedSeq) {
          return { ok: false, total: entries.length, firstBreak: entry.seq };
        }
        if (entryContentHash(entry) !== entry.contentHash) {
          return { ok: false, total: entries.length, firstBreak: entry.seq };
        }
        if (entry.prevHash !== previousHash) {
          return { ok: false, total: entries.length, firstBreak: entry.seq };
        }
        previousHash = linkHash(entry.contentHash, entry.prevHash);
      }
      return { ok: true, total: entries.length, firstBreak: null };
    },

    async anchorState(): Promise<AnchorState> {
      const entries = await deps.repository.allSorted();
      const last = entries[entries.length - 1];
      const head =
        last === undefined
          ? null
          : { seq: last.seq, hash: linkHash(last.contentHash, last.prevHash), count: last.seq };
      const lastAnchor = await readLastAnchor();
      const lastAttempt = await readJournal();

      // Señal de silencio: no depende de ningún evento de la cadena (borrable),
      // depende del diario externo (que un admin de Mongo no puede reescribir).
      let stale = false;
      let staleReason: string | undefined;
      if (head !== null && anchorEvery > 0) {
        if (lastAnchor === null) {
          if (head.seq >= anchorEvery) {
            stale = true;
            staleReason = 'la cadena crece pero no hay ningún anclaje publicado en el diario externo';
          }
        } else {
          const elapsedMinutes = (now().getTime() - new Date(lastAnchor.at).getTime()) / 60_000;
          if (elapsedMinutes > stalenessMinutes) {
            stale = true;
            staleReason = `último anclaje externo hace ${Math.round(elapsedMinutes)} min (umbral ${stalenessMinutes} min)`;
          }
          if (head.seq > lastAnchor.seq + anchorEvery) {
            stale = true;
            staleReason = `la cadena avanzó ${head.seq - lastAnchor.seq} entradas sin anclar (umbral ${anchorEvery})`;
          }
        }
      }
      return { head, lastAnchor, lastAttempt, stale, staleReason, stalenessMinutes };
    },
  };
}