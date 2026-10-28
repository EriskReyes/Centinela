/**
 * Fase 1 — Modelo de datos.
 *
 * Define qué es una "acción" en Centinela: qué tipos existen, qué campos tiene,
 * qué estados puede tener y cómo se validan. Es la fuente de verdad que comparten
 * el motor de reglas, la API, la firma WebAuthn y la auditoría.
 *
 * Dinero en unidades menores (centavos) para evitar errores de coma flotante:
 * 1234_56 = 1.234,56 EUR.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ACTION_TYPES = ['payment', 'reservation', 'loan', 'data_access', 'file_change', 'program_change'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Tipos monetarios: exigen amountMinor (el resto no usa importe). */
export const MONEY_ACTION_TYPES = ['payment', 'reservation', 'loan'] as const;

/** Operaciones válidas por tipo no monetario: texto libre abriría huecos ("borrar" ≠ "delete"). */
export const OPERATIONS_BY_TYPE = {
  file_change: ['create', 'modify', 'delete'],
  program_change: ['deploy', 'configure', 'rollback', 'restart'],
} as const satisfies Partial<Record<ActionType, readonly string[]>>;

/**
 * Operaciones que cambian CONTENIDO: exigen contentHash (SHA-256 del archivo
 * nuevo, del diff o del artefacto a desplegar). Firmar sin él sería firmar
 * "cambia guia.md" sin saber a qué.
 */
const CONTENT_OPERATIONS: Record<string, readonly string[]> = {
  file_change: ['create', 'modify'],
  program_change: ['deploy', 'configure', 'rollback'],
};

const SHA256_HEX = /^[a-f0-9]{64}$/;

export const ACTION_STATUSES = ['proposed', 'pending_signature', 'approved', 'rejected', 'expired'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ENGINE_DECISIONS = ['allow', 'sign', 'block'] as const;
export type EngineDecision = (typeof ENGINE_DECISIONS)[number];

const ISO_4217 = /^[A-Z]{3}$/;

/** Una decisión tomada sobre una acción. Inmutable; es la base del registro de auditoría. */
export const DecisionRecordSchema = z.object({
  id: z.string().min(1),
  /** Dónde se tomó la decisión: motor de reglas, firma humana o ejecución. */
  stage: z.enum(['engine', 'signature', 'execution']),
  decision: z.enum(['allow', 'sign', 'block', 'approved', 'rejected', 'expired']),
  reason: z.string().optional(),
  /** Quién decidió: 'rules-engine', el id del autenticador humano, o 'system'. */
  by: z.string().min(1),
  at: z.coerce.date(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** La acción propuesta por un agente de IA. */
export const AgentActionSchema = z
  .object({
    id: z.string().min(1),
    /** El agente (o sistema) que propone la acción. */
    agentId: z.string().min(1),
    actionType: z.enum(ACTION_TYPES),
    /** Importe en unidades menores; ausente para data_access. */
    amountMinor: z.number().int().nonnegative().optional(),
    /** Código ISO 4217 (EUR, USD, …). Obligatorio solo para tipos monetarios. */
    currency: z.string().regex(ISO_4217, 'currency debe ser un código ISO 4217 válido').optional(),
    /** Destino de la acción: cuenta/IBAN, proveedor, dataset, URL, ruta de archivo… */
    destination: z.string().min(1),
    /** Operación para tipos no monetarios: create | modify | delete | read | deploy… */
    operation: z.string().min(1).optional(),
    /** SHA-256 (hex) del contenido exacto: entra en el reto de firma y el conector lo comprueba. */
    contentHash: z.string().regex(SHA256_HEX, 'contentHash debe ser un SHA-256 en hexadecimal (64 caracteres)').optional(),
    /** Por qué el agente necesita esta acción; el humano que firma la lee. */
    justification: z.string().min(10, 'justification debe explicar por qué el agente necesita la acción'),
    metadata: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(ACTION_STATUSES),
    createdAt: z.coerce.date(),
    decidedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
    decisions: z.array(DecisionRecordSchema),
    /** Cuarto ojos: cuántas firmas de personas distintas exige la política (por defecto 1). */
    requiredSignatures: z.number().int().positive().optional(),
    /** Roles autorizados a firmar (fotografía de la política en el momento de decidir). */
    requiredRoles: z.array(z.string().min(1)).optional(),
    /** Firmas parciales ya recibidas (cuando requiredSignatures > 1). */
    signatures: z
      .array(
        z.object({
          keyId: z.string().min(1),
          userId: z.string().min(1),
          role: z.string().min(1),
          at: z.coerce.date(),
        }),
      )
      .optional(),
  })
  .superRefine((action, ctx) => {
    if ((MONEY_ACTION_TYPES as readonly string[]).includes(action.actionType)) {
      if (action.amountMinor === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amountMinor'],
          message: `${action.actionType} requiere amountMinor`,
        });
      } else if (action.amountMinor <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amountMinor'],
          message: 'amountMinor debe ser mayor que cero',
        });
      }
      if (action.currency === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['currency'],
          message: `${action.actionType} requiere currency (ISO 4217)`,
        });
      }
    }
    if (action.actionType === 'file_change' || action.actionType === 'program_change') {
      const valid: readonly string[] = OPERATIONS_BY_TYPE[action.actionType];
      if (action.operation === undefined || !valid.includes(action.operation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operation'],
          message: `${action.actionType} requiere operation: ${valid.join(' | ')}`,
        });
      } else if (CONTENT_OPERATIONS[action.actionType]?.includes(action.operation) && action.contentHash === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contentHash'],
          message: `${action.actionType}/${action.operation} requiere contentHash (SHA-256 del contenido exacto)`,
        });
      }
    }
  });

/** Forma ya validada (fechas como Date, tipos comprobados). */
export type AgentAction = z.infer<typeof AgentActionSchema>;
/** Forma de entrada (lo que manda el agente a la API). */
export type NewAgentActionInput = z.input<typeof AgentActionSchema>;

/** Máquina de estados de una acción. Solo existen estas transiciones. */
export const STATUS_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  proposed: ['pending_signature', 'approved', 'rejected'],
  pending_signature: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** Decisión del motor → estado resultante (allow → approved, sign → pending_signature, block → rejected). */
export const STATUS_BY_ENGINE_DECISION: Record<EngineDecision, ActionStatus> = {
  allow: 'approved',
  sign: 'pending_signature',
  block: 'rejected',
};

/** Expira una solicitud pendiente de firma si se pasó de fecha, dejando constancia. */
export function expirePendingAction(
  action: AgentAction,
  now: Date = new Date(),
  idFactory: () => string = randomUUID,
): AgentAction {
  if (action.status !== 'pending_signature' || action.expiresAt === undefined || now < action.expiresAt) {
    return action;
  }
  return {
    ...action,
    status: 'expired',
    decidedAt: now,
    decisions: [
      ...action.decisions,
      {
        id: idFactory(),
        stage: 'signature',
        decision: 'expired',
        reason: 'solicitud de firma expirada sin respuesta',
        by: 'system',
        at: now,
      } satisfies DecisionRecord,
    ],
  };
}

/** Violación de la máquina de estados: se intentó una transición que no existe. */
export class InvalidTransitionError extends Error {
  readonly from: ActionStatus;
  readonly to: ActionStatus;

  constructor(from: ActionStatus, to: ActionStatus) {
    super(`transición no permitida: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Cuarto ojos: la misma llave o la misma persona ya firmó esta acción.
 * El middleware de la API lo expone como 409 (status numérico estructural).
 */
export class SignatureAlreadyPresentError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SignatureAlreadyPresentError';
  }
}

/** Cuarto ojos por roles: la llave no tiene un rol autorizado para esta acción. */
export class RoleNotAuthorizedError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'RoleNotAuthorizedError';
  }
}

/**
 * Aplica la decisión de un humano (firmada con WebAuthn) a una acción pendiente.
 *
 * - 'rejected': veto inmediato → rejected.
 * - 'approved': firma parcial; si se alcanza el quórum de PERSONAS distintas
 *   (requiredSignatures, por defecto 1) → approved; si no, sigue pendiente.
 *
 * Si la política define requiredRoles, TODAS las firmas (aprobación y veto)
 * deben venir de llaves con uno de esos roles.
 * Devuelve una acción nueva (inmutable) y registra qué llave firmó.
 */
export function applyHumanDecision(
  action: AgentAction,
  decision: 'approved' | 'rejected',
  credentialId: string,
  userId: string,
  role: string,
  now: Date = new Date(),
  idFactory: () => string = randomUUID,
): AgentAction {
  if (action.status !== 'pending_signature') {
    throw new InvalidTransitionError(action.status, decision);
  }
  if (
    action.requiredRoles !== undefined &&
    action.requiredRoles.length > 0 &&
    !action.requiredRoles.includes(role)
  ) {
    throw new RoleNotAuthorizedError(
      `el rol '${role}' no puede firmar esta acción (se requieren: ${action.requiredRoles.join(', ')})`,
    );
  }
  const record: DecisionRecord = {
    id: idFactory(),
    stage: 'signature',
    decision,
    reason:
      decision === 'rejected'
        ? `rechazada y firmada por la llave '${credentialId}' (${userId}, ${role})`
        : `firmada por la llave '${credentialId}' (${userId}, ${role})`,
    by: credentialId,
    at: now,
  };
  const withRecord: AgentAction = {
    ...action,
    decisions: [...action.decisions, record],
  };

  if (decision === 'rejected') {
    return { ...withRecord, status: 'rejected', decidedAt: now };
  }

  // Aprobación parcial: la misma llave o la misma persona no cuentan dos veces.
  const existing = action.signatures ?? [];
  if (existing.some((s) => s.keyId === credentialId)) {
    throw new SignatureAlreadyPresentError('esta llave ya firmó esta acción: se necesita una persona distinta');
  }
  if (existing.some((s) => s.userId === userId)) {
    throw new SignatureAlreadyPresentError('esta persona ya firmó esta acción: se necesita una persona distinta');
  }
  const signatures = [...existing, { keyId: credentialId, userId, role, at: now }];
  const required = action.requiredSignatures ?? 1;
  const reached = signatures.length >= required;
  return {
    ...withRecord,
    signatures,
    status: reached ? 'approved' : 'pending_signature',
    decidedAt: reached ? now : withRecord.decidedAt,
  };
}
