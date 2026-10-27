/**
 * Fase 2 — Motor de reglas.
 *
 * Lógica pura y determinista: recibe una acción propuesta + la política de la
 * empresa y devuelve una decisión con sus motivos. Sin red, sin base de datos,
 * sin estado: por eso se puede probar exhaustivamente en aislamiento.
 *
 * Prioridad de las decisiones: block > sign > allow.
 */
import { randomUUID } from 'node:crypto';
import {
  ACTION_TYPES,
  STATUS_BY_ENGINE_DECISION,
  type AgentAction,
  type DecisionRecord,
  type EngineDecision,
} from '../domain/action.ts';
import type { Policy } from './policy.ts';

export interface EngineDecisionResult {
  decision: EngineDecision;
  /** Motivos legibles: para el registro de auditoría y para el humano que firma. */
  reasons: string[];
  /** Versión de la política usada; queda guardada con la decisión. */
  policyVersion: number;
  /** TTL en minutos para solicitudes pendientes de firma (de la política). */
  pendingTtlMinutes: number;
  /** Cuarto ojos: firmas de personas distintas exigidas (solo en 'sign'). */
  requiredSignatures?: number;
  /** Roles autorizados a firmar (solo en 'sign'; fotografía de la política). */
  requiredRoles?: string[];
}

/** Un patrón terminado en '*' coincide por prefijo; si no, comparación exacta. */
export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

/**
 * Lo que el motor necesita saber del pasado. Lo calcula quien llama (la API
 * consulta el repositorio); el motor sigue siendo puro y sin base de datos.
 */
export interface EvaluationContext {
  /** Suma de lo que ESTE agente ya ejecutó sin firma en la ventana (misma moneda y tipo). */
  autoApprovedInWindowMinor: number;
}

export function evaluateAction(action: AgentAction, policy: Policy, context: EvaluationContext): EngineDecisionResult {
  const reasonsByLevel: Record<EngineDecision, string[]> = { allow: [], sign: [], block: [] };
  const block = (reason: string) => reasonsByLevel.block.push(reason);
  const sign = (reason: string) => reasonsByLevel.sign.push(reason);
  let requiredSignatures: number | undefined;

  // Defensa en profundidad: la validación ya lo impide, pero el motor no confía en su entrada.
  if (action.status !== 'proposed') {
    block(`solo se evalúan acciones en estado 'proposed'; recibida en '${action.status}'`);
  }
  if (!ACTION_TYPES.includes(action.actionType)) {
    block(`tipo de acción no reconocido: '${action.actionType}'`);
    return finish(reasonsByLevel, policy);
  }

  const typePolicy = policy.types[action.actionType];
  if (typePolicy === undefined) {
    block(`la política ${policy.id} no define reglas para '${action.actionType}'`);
    return finish(reasonsByLevel, policy);
  }
  if (!typePolicy.allowed) {
    block(`el tipo '${action.actionType}' está deshabilitado por la política`);
  }

  if (
    typePolicy.currencies !== undefined &&
    typePolicy.currencies.length > 0 &&
    !typePolicy.currencies.includes(action.currency)
  ) {
    block(
      `moneda '${action.currency}' no permitida para '${action.actionType}' (permitidas: ${typePolicy.currencies.join(', ')})`,
    );
  }

  // Reglas de importe (solo para acciones monetarias).
  if (action.actionType !== 'data_access') {
    const amount = action.amountMinor;
    if (amount === undefined) {
      block(`la acción '${action.actionType}' no trae importe`);
    } else if (amount <= 0) {
      block(`importe inválido: ${amount}`);
    } else {
      if (typePolicy.signLimitMinor !== undefined && amount > typePolicy.signLimitMinor) {
        block(
          `importe ${fmtMinor(amount, action.currency)} supera el límite máximo de ${fmtMinor(typePolicy.signLimitMinor, action.currency)}`,
        );
      }
      if (typePolicy.allowLimitMinor !== undefined && amount > typePolicy.allowLimitMinor) {
        sign(
          `importe ${fmtMinor(amount, action.currency)} supera el límite de aprobación automática de ${fmtMinor(typePolicy.allowLimitMinor, action.currency)}`,
        );
        // Cuarto ojos: dentro de la banda de firma, por encima del umbral
        // de quórum hacen falta N personas distintas.
        requiredSignatures =
          typePolicy.quorumAboveMinor !== undefined && amount > typePolicy.quorumAboveMinor
            ? (typePolicy.quorumSignatures ?? 1)
            : 1;
      }
      // Tope acumulado: pagos pequeños sueltos no pueden sumar un pago grande sin firma.
      const cumulativeLimit = typePolicy.cumulativeAllowLimitMinor;
      if (cumulativeLimit !== undefined && context.autoApprovedInWindowMinor + amount > cumulativeLimit) {
        sign(
          `gasto sin firma acumulado de '${action.agentId}' (${fmtMinor(context.autoApprovedInWindowMinor, action.currency)} + ${fmtMinor(amount, action.currency)}) supera el tope de ${fmtMinor(cumulativeLimit, action.currency)} en ${typePolicy.cumulativeWindowMinutes} min`,
        );
      }
    }
  }

  // Reglas de destino.
  for (const pattern of policy.destinationDeny) {
    if (matchesPattern(action.destination, pattern)) {
      block(`destino '${action.destination}' prohibido por la política (patrón '${pattern}')`);
    }
  }
  const isTrusted = policy.destinationTrusted.some((pattern) => matchesPattern(action.destination, pattern));
  if (policy.requireSignOnNewDestination && !isTrusted) {
    sign(`destino '${action.destination}' no está en la lista de confianza: requiere verificación humana`);
  }

  // Roles del quórum: fotografía de la política si la firma los exige.
  let requiredRoles: string[] | undefined;
  if (reasonsByLevel.sign.length > 0 && typePolicy.quorumRoles !== undefined) {
    requiredRoles = typePolicy.quorumRoles;
  }

  return finish(reasonsByLevel, policy, requiredSignatures, requiredRoles);
}

function finish(
  reasonsByLevel: Record<EngineDecision, string[]>,
  policy: Policy,
  requiredSignatures?: number,
  requiredRoles?: string[],
): EngineDecisionResult {
  const decision: EngineDecision =
    reasonsByLevel.block.length > 0 ? 'block' : reasonsByLevel.sign.length > 0 ? 'sign' : 'allow';
  return {
    decision,
    reasons: reasonsByLevel[decision],
    policyVersion: policy.version,
    pendingTtlMinutes: policy.pendingTtlMinutes,
    requiredSignatures: decision === 'sign' ? (requiredSignatures ?? 1) : undefined,
    requiredRoles: decision === 'sign' ? requiredRoles : undefined,
  };
}

/** Formatea unidades menores: 1234_56 → "1234.56 EUR". */
export function fmtMinor(amountMinor: number, currency: string): string {
  const major = Math.floor(amountMinor / 100);
  const minor = String(amountMinor % 100).padStart(2, '0');
  return `${major}.${minor} ${currency}`;
}

/**
 * Aplica la decisión del motor a la acción: devuelve una acción NUEVA con el
 * estado correspondiente y su DecisionRecord añadido (inmutable). Para 'sign'
 * fija además la fecha de expiración según el TTL de la política.
 */
export function applyEngineDecision(
  action: AgentAction,
  result: EngineDecisionResult,
  now: Date = new Date(),
  idFactory: () => string = randomUUID,
): AgentAction {
  const record: DecisionRecord = {
    id: idFactory(),
    stage: 'engine',
    decision: result.decision,
    reason: result.reasons.join(' | '),
    by: 'rules-engine',
    at: now,
  };
  const nextStatus = STATUS_BY_ENGINE_DECISION[result.decision];
  const expiresAt =
    nextStatus === 'pending_signature'
      ? new Date(now.getTime() + result.pendingTtlMinutes * 60_000)
      : action.expiresAt;
  return {
    ...action,
    status: nextStatus,
    decidedAt: now,
    expiresAt,
    decisions: [...action.decisions, record],
    // Cuarto ojos: la pendiente nace con su exigencia de firmas, roles y cero recibidas.
    ...(nextStatus === 'pending_signature'
      ? {
          requiredSignatures: result.requiredSignatures ?? 1,
          requiredRoles: result.requiredRoles,
          signatures: [],
        }
      : {}),
  };
}
