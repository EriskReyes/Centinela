/**
 * Fase 3 (persistencia) — Modelos Mongoose.
 *
 * El dominio (src/domain) es la fuente de verdad; aquí solo se define cómo se
 * guarda en MongoDB. Los mapeos actionToDoc/docToAction mantienen separados
 * ambos mundos. El _id de MongoDB es el id del dominio (UUID).
 */
import mongoose, { type Model } from 'mongoose';
import type { ActionStatus, ActionType, AgentAction, DecisionRecord } from '../domain/action.ts';
import type { Policy } from '../rules/policy.ts';

const decisionRecordSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    stage: { type: String, required: true, enum: ['engine', 'signature', 'execution'] },
    decision: {
      type: String,
      required: true,
      enum: ['allow', 'sign', 'block', 'approved', 'rejected', 'expired'],
    },
    reason: { type: String },
    by: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

export interface ActionDoc {
  _id: string;
  agentId: string;
  actionType: ActionType;
  amountMinor?: number;
  currency: string;
  destination: string;
  justification: string;
  metadata?: Record<string, unknown>;
  status: ActionStatus;
  createdAt: Date;
  decidedAt?: Date;
  expiresAt?: Date;
  decisions: DecisionRecord[];
  requiredSignatures?: number;
  requiredRoles?: string[];
  signatures?: Array<{ keyId: string; userId: string; role: string; at: Date }>;
}

const actionSchema = new mongoose.Schema<ActionDoc>(
  {
    _id: { type: String },
    agentId: { type: String, required: true, index: true },
    actionType: { type: String, required: true, enum: ['payment', 'reservation', 'loan', 'data_access'] },
    amountMinor: { type: Number },
    currency: { type: String, required: true },
    destination: { type: String, required: true },
    justification: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
    status: {
      type: String,
      required: true,
      enum: ['proposed', 'pending_signature', 'approved', 'rejected', 'expired'],
    },
    createdAt: { type: Date, required: true },
    decidedAt: { type: Date },
    expiresAt: { type: Date },
    decisions: { type: [decisionRecordSchema], default: [] },
    requiredSignatures: { type: Number },
    requiredRoles: { type: [String] },
    signatures: {
      type: [
        new mongoose.Schema(
          {
            keyId: { type: String, required: true },
            userId: { type: String, required: true },
            role: { type: String, required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
  },
  { versionKey: false },
);

actionSchema.index({ status: 1, createdAt: -1 });
// Idempotencia: dos envíos con la misma clave no crean dos acciones.
actionSchema.index({ 'metadata.idempotencyKey': 1 }, { unique: true, sparse: true });

export const ActionModel: Model<ActionDoc> =
  (mongoose.models.Action as Model<ActionDoc> | undefined) ?? mongoose.model<ActionDoc>('Action', actionSchema);

/** La política se guarda tal cual (objeto); se valida con PolicySchema al leer. */
export interface PolicyDoc extends Policy {
  _id?: unknown;
}

const policySchema = new mongoose.Schema<PolicyDoc>(
  {
    id: { type: String, required: true },
    version: { type: Number, required: true },
    types: { type: mongoose.Schema.Types.Mixed, required: true },
    destinationDeny: { type: [String], required: true },
    destinationTrusted: { type: [String], required: true },
    requireSignOnNewDestination: { type: Boolean, required: true },
    pendingTtlMinutes: { type: Number, required: true },
  },
  { versionKey: false },
);
// Cada versión de la política se guarda como un documento nuevo: (id, version) único.
policySchema.index({ id: 1, version: 1 }, { unique: true });

export const PolicyModel: Model<PolicyDoc> =
  (mongoose.models.Policy as Model<PolicyDoc> | undefined) ?? mongoose.model<PolicyDoc>('Policy', policySchema);

// ---------------------------------------------------------------------------
// Fase 4 — Credenciales WebAuthn y retos de firma.
// ---------------------------------------------------------------------------

/** Llave WebAuthn registrada por un humano. */
export interface CredentialDoc {
  /** credentialId en base64url. */
  _id: string;
  userId: string;
  /** Rol de la persona para el cuarto ojos ('autorizador', 'empleado'…). */
  role?: string;
  /** Clave pública COSE en base64url. */
  publicKey: string;
  /** Contador de usos reportado por el autenticador (anti-replay). */
  counter: number;
  transports?: string[];
  createdAt: Date;
  /** Revocada por un administrador (llave perdida). */
  revokedAt?: Date;
}

const credentialSchema = new mongoose.Schema<CredentialDoc>(
  {
    _id: { type: String },
    userId: { type: String, required: true, index: true },
    role: { type: String, default: 'empleado' },
    publicKey: { type: String, required: true },
    counter: { type: Number, required: true },
    transports: { type: [String] },
    createdAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { versionKey: false },
);

export const CredentialModel: Model<CredentialDoc> =
  (mongoose.models.Credential as Model<CredentialDoc> | undefined) ??
  mongoose.model<CredentialDoc>('Credential', credentialSchema);

/**
 * Retos WebAuthn de UN SOLO USO. El TTL index solo es limpieza: el consumo
 * los borra antes. Un reto consumido no se puede volver a usar jamás.
 */
export interface ChallengeDoc {
  key: string;
  value: string;
  createdAt: Date;
  expiresAt: Date;
}

const challengeSchema = new mongoose.Schema<ChallengeDoc>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ChallengeModel: Model<ChallengeDoc> =
  (mongoose.models.Challenge as Model<ChallengeDoc> | undefined) ??
  mongoose.model<ChallengeDoc>('Challenge', challengeSchema);

// ---------------------------------------------------------------------------
// Fase 5 — Registro de auditoría (append-only con cadena de hashes).
// ---------------------------------------------------------------------------

export interface AuditEntryDoc {
  _id: string;
  seq: number;
  eventType: string;
  actionId: string;
  actor: string;
  decision?: string;
  statusBefore?: string;
  statusAfter?: string;
  reason?: string;
  policyVersion?: number;
  at: Date;
  contentHash: string;
  prevHash: string;
}

const auditEntrySchema = new mongoose.Schema<AuditEntryDoc>(
  {
    _id: { type: String },
    seq: { type: Number, required: true, unique: true },
    eventType: { type: String, required: true, index: true },
    actionId: { type: String, required: true, index: true },
    actor: { type: String, required: true },
    decision: { type: String },
    statusBefore: { type: String },
    statusAfter: { type: String },
    reason: { type: String },
    policyVersion: { type: Number },
    at: { type: Date, required: true },
    contentHash: { type: String, required: true },
    prevHash: { type: String, required: true },
  },
  { versionKey: false },
);
auditEntrySchema.index({ actionId: 1, seq: 1 });

export const AuditModel: Model<AuditEntryDoc> =
  (mongoose.models.AuditEntry as Model<AuditEntryDoc> | undefined) ??
  mongoose.model<AuditEntryDoc>('AuditEntry', auditEntrySchema);

/** Contador atómico de la secuencia del registro (upsert + $inc). */
const auditSeqSchema = new mongoose.Schema(
  {
    _id: { type: String },
    value: { type: Number, required: true },
  },
  { versionKey: false },
);

export const AuditSeqModel =
  (mongoose.models.AuditSeq as Model<{ _id: string; value: number }> | undefined) ??
  mongoose.model<{ _id: string; value: number }>('AuditSeq', auditSeqSchema);

/** Dominio → documento Mongo. */
export function actionToDoc(action: AgentAction): ActionDoc {
  const { id, ...rest } = action;
  return { _id: id, ...rest };
}

/** Documento Mongo → dominio. */
export function docToAction(doc: ActionDoc): AgentAction {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}
