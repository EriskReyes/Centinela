/**
 * Fase 4 — Almacenes de credenciales WebAuthn y de retos de firma.
 *
 * Igual que con las acciones: la lógica depende de interfaces; producción usa
 * MongoDB y los tests usan memoria.
 */
import { ChallengeModel, CredentialModel, type ChallengeDoc, type CredentialDoc } from '../db/models.ts';
import type { HumanDecision } from './signing.ts';

export interface WebAuthnCredentialRecord {
  /** credentialId en base64url. */
  id: string;
  userId: string;
  /** Rol de la persona (cuarto ojos): 'autorizador', 'empleado', etc. */
  role: string;
  /** Clave pública COSE en base64url. */
  publicKey: string;
  /** Contador de usos del autenticador (anti-replay). */
  counter: number;
  transports: string[];
  createdAt: Date;
  /** Llave revocada por un administrador: ya no puede firmar. */
  revokedAt?: Date;
}

export interface CredentialRepository {
  insert(record: WebAuthnCredentialRecord): Promise<void>;
  findById(id: string): Promise<WebAuthnCredentialRecord | null>;
  listByUser(userId: string): Promise<WebAuthnCredentialRecord[]>;
  /** Todas las llaves (el panel las lista para revocarlas). */
  listAll(): Promise<WebAuthnCredentialRecord[]>;
  updateCounter(id: string, counter: number): Promise<void>;
  /** Revoca la llave; devuelve false si no existía. */
  revoke(id: string, now: Date): Promise<boolean>;
}

export interface ChallengeRepository {
  saveSigning(actionId: string, decision: HumanDecision, value: string, now: Date, ttlMinutes: number): Promise<void>;
  /** De UN SOLO USO: devuelve el reto y lo borra. null si no existe o expiró. */
  consumeSigning(actionId: string, decision: HumanDecision, now: Date): Promise<string | null>;
  saveRegistration(userId: string, value: string, now: Date, ttlMinutes: number): Promise<void>;
  consumeRegistration(userId: string, now: Date): Promise<string | null>;
}

const signingKey = (actionId: string, decision: HumanDecision): string => `sign:${actionId}:${decision}`;
const registrationKey = (userId: string): string => `reg:${userId}`;

export class InMemoryCredentialRepository implements CredentialRepository {
  private readonly byId = new Map<string, WebAuthnCredentialRecord>();

  async insert(record: WebAuthnCredentialRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async findById(id: string): Promise<WebAuthnCredentialRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listByUser(userId: string): Promise<WebAuthnCredentialRecord[]> {
    return [...this.byId.values()].filter((c) => c.userId === userId);
  }

  async listAll(): Promise<WebAuthnCredentialRecord[]> {
    return [...this.byId.values()];
  }

  async updateCounter(id: string, counter: number): Promise<void> {
    const record = this.byId.get(id);
    if (record !== undefined) {
      this.byId.set(id, { ...record, counter });
    }
  }

  async revoke(id: string, now: Date): Promise<boolean> {
    const record = this.byId.get(id);
    if (record === undefined) {
      return false;
    }
    this.byId.set(id, { ...record, revokedAt: now });
    return true;
  }
}

export class MongoCredentialRepository implements CredentialRepository {
  async insert(record: WebAuthnCredentialRecord): Promise<void> {
    await CredentialModel.create({ ...record, _id: record.id });
  }

  async findById(id: string): Promise<WebAuthnCredentialRecord | null> {
    const doc = (await CredentialModel.findById(id).lean()) as unknown as CredentialDoc | null;
    return doc === null ? null : toRecord(doc);
  }

  async listByUser(userId: string): Promise<WebAuthnCredentialRecord[]> {
    const docs = (await CredentialModel.find({ userId }).sort({ createdAt: 1 }).lean()) as unknown as CredentialDoc[];
    return docs.map(toRecord);
  }

  async listAll(): Promise<WebAuthnCredentialRecord[]> {
    const docs = (await CredentialModel.find().sort({ createdAt: 1 }).lean()) as unknown as CredentialDoc[];
    return docs.map(toRecord);
  }

  async updateCounter(id: string, counter: number): Promise<void> {
    await CredentialModel.updateOne({ _id: id }, { $set: { counter } });
  }

  async revoke(id: string, now: Date): Promise<boolean> {
    const result = await CredentialModel.updateOne({ _id: id, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
    return result.modifiedCount === 1;
  }
}

function toRecord(doc: CredentialDoc): WebAuthnCredentialRecord {
  return {
    id: doc._id,
    userId: doc.userId,
    role: doc.role ?? 'empleado',
    publicKey: doc.publicKey,
    counter: doc.counter,
    transports: doc.transports ?? [],
    createdAt: doc.createdAt,
    revokedAt: doc.revokedAt,
  };
}

export class InMemoryChallengeRepository implements ChallengeRepository {
  private readonly byKey = new Map<string, { value: string; expiresAt: Date }>();

  private save(key: string, value: string, now: Date, ttlMinutes: number): Promise<void> {
    this.byKey.set(key, { value, expiresAt: new Date(now.getTime() + ttlMinutes * 60_000) });
    return Promise.resolve();
  }

  private consume(key: string, now: Date): Promise<string | null> {
    const entry = this.byKey.get(key);
    if (entry === undefined) {
      return Promise.resolve(null);
    }
    this.byKey.delete(key);
    return Promise.resolve(now <= entry.expiresAt ? entry.value : null);
  }

  saveSigning(actionId: string, decision: HumanDecision, value: string, now: Date, ttlMinutes: number): Promise<void> {
    return this.save(signingKey(actionId, decision), value, now, ttlMinutes);
  }

  consumeSigning(actionId: string, decision: HumanDecision, now: Date): Promise<string | null> {
    return this.consume(signingKey(actionId, decision), now);
  }

  saveRegistration(userId: string, value: string, now: Date, ttlMinutes: number): Promise<void> {
    return this.save(registrationKey(userId), value, now, ttlMinutes);
  }

  consumeRegistration(userId: string, now: Date): Promise<string | null> {
    return this.consume(registrationKey(userId), now);
  }
}

export class MongoChallengeRepository implements ChallengeRepository {
  private save(key: string, value: string, now: Date, ttlMinutes: number): Promise<void> {
    const doc: ChallengeDoc = {
      key,
      value,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    };
    return ChallengeModel.replaceOne({ key }, doc, { upsert: true }).then(() => undefined);
  }

  private async consume(key: string, now: Date): Promise<string | null> {
    const doc = await ChallengeModel.findOneAndDelete({ key, expiresAt: { $gt: now } }).lean();
    return doc?.value ?? null;
  }

  saveSigning(actionId: string, decision: HumanDecision, value: string, now: Date, ttlMinutes: number): Promise<void> {
    return this.save(signingKey(actionId, decision), value, now, ttlMinutes);
  }

  consumeSigning(actionId: string, decision: HumanDecision, now: Date): Promise<string | null> {
    return this.consume(signingKey(actionId, decision), now);
  }

  saveRegistration(userId: string, value: string, now: Date, ttlMinutes: number): Promise<void> {
    return this.save(registrationKey(userId), value, now, ttlMinutes);
  }

  consumeRegistration(userId: string, now: Date): Promise<string | null> {
    return this.consume(registrationKey(userId), now);
  }
}
