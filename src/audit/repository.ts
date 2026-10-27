/**
 * Fase 5 — Almacén del registro de auditoría (append-only).
 */
import { AuditModel, AuditSeqModel, type AuditEntryDoc } from '../db/models.ts';
import type { AuditEntry, AuditEventType } from './events.ts';

export interface AuditListFilter {
  actionId?: string;
  eventType?: AuditEventType;
  actor?: string;
  limit: number;
}

export interface AuditRepository {
  /** Secuencia monótona y sin huecos (atómica en Mongo). */
  nextSeq(): Promise<number>;
  insert(entry: AuditEntry): Promise<void>;
  /** Última entrada del registro (para encadenar). */
  latest(): Promise<AuditEntry | null>;
  list(filter: AuditListFilter): Promise<AuditEntry[]>;
  /** TODO el registro en orden de secuencia (para verificar la cadena). */
  allSorted(): Promise<AuditEntry[]>;
  findByAction(actionId: string): Promise<AuditEntry[]>;
}

export class InMemoryAuditRepository implements AuditRepository {
  private seqCounter = 0;
  /** Acceso directo para que los tests puedan simular manipulación del registro. */
  readonly entries: AuditEntry[] = [];

  async nextSeq(): Promise<number> {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  async insert(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  async latest(): Promise<AuditEntry | null> {
    return this.entries.length === 0 ? null : (this.entries[this.entries.length - 1] ?? null);
  }

  async list(filter: AuditListFilter): Promise<AuditEntry[]> {
    const result = this.entries.filter(
      (entry) =>
        (filter.actionId === undefined || entry.actionId === filter.actionId) &&
        (filter.eventType === undefined || entry.eventType === filter.eventType) &&
        (filter.actor === undefined || entry.actor === filter.actor),
    );
    result.sort((a, b) => b.seq - a.seq);
    return result.slice(0, filter.limit);
  }

  async allSorted(): Promise<AuditEntry[]> {
    return [...this.entries].sort((a, b) => a.seq - b.seq);
  }

  async findByAction(actionId: string): Promise<AuditEntry[]> {
    return this.entries.filter((entry) => entry.actionId === actionId).sort((a, b) => a.seq - b.seq);
  }
}

export class MongoAuditRepository implements AuditRepository {
  async nextSeq(): Promise<number> {
    const doc = await AuditSeqModel.findOneAndUpdate(
      { _id: 'audit' },
      { $inc: { value: 1 } },
      { upsert: true, new: true },
    ).lean();
    return ((doc as unknown as { value: number } | null)?.value) ?? 0;
  }

  async insert(entry: AuditEntry): Promise<void> {
    await AuditModel.create(toDoc(entry));
  }

  async latest(): Promise<AuditEntry | null> {
    const docs = (await AuditModel.find().sort({ seq: -1 }).limit(1).lean()) as unknown as AuditEntryDoc[];
    return docs.length === 0 ? null : toEntry(docs[0] ?? (null as never));
  }

  async list(filter: AuditListFilter): Promise<AuditEntry[]> {
    const query: Record<string, string> = {};
    if (filter.actionId !== undefined) query.actionId = filter.actionId;
    if (filter.eventType !== undefined) query.eventType = filter.eventType;
    if (filter.actor !== undefined) query.actor = filter.actor;
    const docs = (await AuditModel.find(query).sort({ seq: -1 }).limit(filter.limit).lean()) as unknown as AuditEntryDoc[];
    return docs.map(toEntry);
  }

  async allSorted(): Promise<AuditEntry[]> {
    const docs = (await AuditModel.find().sort({ seq: 1 }).lean()) as unknown as AuditEntryDoc[];
    return docs.map(toEntry);
  }

  async findByAction(actionId: string): Promise<AuditEntry[]> {
    const docs = (await AuditModel.find({ actionId }).sort({ seq: 1 }).lean()) as unknown as AuditEntryDoc[];
    return docs.map(toEntry);
  }
}

function toDoc(entry: AuditEntry): AuditEntryDoc {
  const { id, ...rest } = entry;
  return { _id: id, ...rest };
}

function toEntry(doc: AuditEntryDoc): AuditEntry {
  const { _id, ...rest } = doc;
  return {
    id: _id,
    ...rest,
    eventType: doc.eventType as AuditEventType,
    statusBefore: doc.statusBefore as AuditEntry['statusBefore'],
    statusAfter: doc.statusAfter as AuditEntry['statusAfter'],
  };
}
