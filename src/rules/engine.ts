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
  MONEY_ACTION_TYPES,
  STATUS_BY_ENGINE_DECISION,
  type AgentAction,
  type DecisionRecord,
  type EngineDecision,
} from '../domain/action.ts';
import type { Policy } from './policy.ts';
import { hasControlChars, hasParentSegment, normalizePath } from '../domain/paths.ts';

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

/**
 * `*` coincide con cualquier secuencia (también con `/`) y puede ir en
 * cualquier posición: `crypto:*`, `*\/.env*`, `*id_rsa*`. Sin `*`, exacto.
 * `ignoreCase` para las listas de PROHIBIDOS: ahí distinguir mayúsculas solo
 * abre huecos (`CRYPTO:x`, `C:/WINDOWS`). Las de confianza son estrictas.
 */
export function matchesPattern(value: string, pattern: string, ignoreCase = false): boolean {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`, ignoreCase ? 'is' : 's').test(value);
}

/** Tipos cuyo destino es una ruta: se comparan en forma canónica (ver domain/paths.ts). */
const PATH_ACTION_TYPES: readonly string[] = ['file_change', 'program_change'];

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
    (action.currency === undefined || !typePolicy.currencies.includes(action.currency))
  ) {
    block(
      `moneda '${action.currency ?? '—'}' no permitida para '${action.actionType}' (permitidas: ${typePolicy.currencies.join(', ')})`,
    );
  }

  // Reglas de importe (solo para acciones monetarias).
  if ((MONEY_ACTION_TYPES as readonly string[]).includes(action.actionType)) {
    const amount = action.amountMinor;
    const currency = action.currency ?? '';
    if (amount === undefined) {
      block(`la acción '${action.actionType}' no trae importe`);
    } else if (amount <= 0) {
      block(`importe inválido: ${amount}`);
    } else {
      if (typePolicy.signLimitMinor !== undefined && amount > typePolicy.signLimitMinor) {
        block(
          `importe ${fmtMinor(amount, currency)} supera el límite máximo de ${fmtMinor(typePolicy.signLimitMinor, currency)}`,
        );
      }
      if (typePolicy.allowLimitMinor !== undefined && amount > typePolicy.allowLimitMinor) {
        sign(
          `importe ${fmtMinor(amount, currency)} supera el límite de aprobación automática de ${fmtMinor(typePolicy.allowLimitMinor, currency)}`,
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
          `gasto sin firma acumulado de '${action.agentId}' (${fmtMinor(context.autoApprovedInWindowMinor, currency)} + ${fmtMinor(amount, currency)}) supera el tope de ${fmtMinor(cumulativeLimit, currency)} en ${typePolicy.cumulativeWindowMinutes} min`,
        );
      }
    }
  }

  // Operaciones que siempre exigen firma (borrar, desplegar…), sea cual sea el destino.
  if (action.operation !== undefined && typePolicy.signOperations?.includes(action.operation)) {
    sign(`la operación '${action.operation}' de '${action.actionType}' siempre requiere firma humana`);
  }

  // Reglas de destino. Las rutas se comparan en forma canónica y `..` se
  // bloquea: `docs/../.env` no puede pasar por "dentro de docs/".
  const isPath = PATH_ACTION_TYPES.includes(action.actionType);
  const destination = isPath ? normalizePath(action.destination) : action.destination;
  if (hasControlChars(action.destination)) {
    block('el destino contiene caracteres de control');
  }
  if (isPath && hasParentSegment(action.destination)) {
    block(`la ruta '${action.destination}' contiene '..': no se permite salir del directorio`);
  }
  for (const pattern of policy.destinationDeny) {
    const canonical = isPath ? normalizePath(pattern) : pattern;
    if (matchesPattern(destination, canonical, true)) {
      block(`destino '${action.destination}' prohibido por la política (patrón '${pattern}')`);
    }
  }
  const isTrusted = policy.destinationTrusted.some((pattern) =>
    matchesPattern(destination, isPath ? normalizePath(pattern) : pattern),
  );
  if (policy.requireSignOnNewDestination && !isTrusted) {
    sign(`destino '${action.destination}' no está en la lista de confianza: requiere verificación humana`);
  }

  // Roles del quórum: fotografía de la política si la firma los exige.
  let requiredRoles: string[] | undefined;
  if (reasonsByLevel.sign.length > 0 && typePolicy.quorumRoles !== undefined) {
    requiredRoles = typePolicy.quorumRoles;
  }
  // Quórum sin umbral de importe (tipos no monetarios como program_change):
  // TODA firma de este tipo exige N personas. Para tipos monetarios el quórum
  // lo decide la banda de importe (y un desborde del tope acumulado solo
  // escala a UNA firma, no al quórum completo).
  if (
    reasonsByLevel.sign.length > 0 &&
    requiredSignatures === undefined &&
    typePolicy.quorumAboveMinor === undefined &&
    typePolicy.quorumSignatures !== undefined
  ) {
    requiredSignatures = typePolicy.quorumSignatures;
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
