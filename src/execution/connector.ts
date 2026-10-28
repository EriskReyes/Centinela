/**
 * Fase 3 — Conectores de ejecución SIMULADOS.
 *
 * En un sistema real aquí habría llamadas a bancos y APIs. Para el portafolio,
 * "ejecutar" es registrar el resultado: la arquitectura (decisión → ejecución
 * auditada) es idéntica. El destino 'proveedor-caido.es' simula un fallo.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ActionType, AgentAction, DecisionRecord } from '../domain/action.ts';
import { fmtMinor } from '../rules/engine.ts';

export interface ExecutionResult {
  ok: boolean;
  connector: string;
  detail: string;
}

const CONNECTOR_BY_TYPE: Record<Exclude<ActionType, 'loan'>, string> = {
  payment: 'simulador-pagos',
  reservation: 'simulador-reservas',
  data_access: 'simulador-datos',
  file_change: 'simulador-archivos',
  program_change: 'simulador-programa',
};

export function executeAction(action: AgentAction, now: Date = new Date()): ExecutionResult {
  const connector = CONNECTOR_BY_TYPE[action.actionType as Exclude<ActionType, 'loan'>] ?? 'desconocido';
  if (action.destination === 'proveedor-caido.es') {
    return { ok: false, connector, detail: `el proveedor '${action.destination}' no respondió (fallo simulado)` };
  }
  switch (action.actionType) {
    case 'payment':
      return {
        ok: true,
        connector,
        detail: `pago simulado de ${fmtMinor(action.amountMinor ?? 0, action.currency ?? '')} a '${action.destination}'`,
      };
    case 'reservation':
      return {
        ok: true,
        connector,
        detail: `reserva simulada en '${action.destination}' por ${fmtMinor(action.amountMinor ?? 0, action.currency ?? '')}`,
      };
    case 'data_access':
      return { ok: true, connector, detail: `lectura simulada de '${action.destination}' completada` };
    case 'file_change':
      return {
        ok: true,
        connector,
        detail: `cambio de archivo simulado en '${action.destination}' (${action.operation ?? 'sin operación'}${hashNote(action)})`,
      };
    case 'program_change':
      return {
        ok: true,
        connector,
        detail: `cambio de programa simulado en '${action.destination}' (${action.operation ?? 'sin operación'}${hashNote(action)})`,
      };
    default:
      return { ok: false, connector, detail: `el tipo '${action.actionType}' no tiene conector de ejecución` };
  }
}

const hashNote = (action: AgentAction) =>
  action.contentHash === undefined ? '' : `, contenido ${action.contentHash.slice(0, 12)}…`;

/**
 * Lo que debe hacer un conector REAL de archivos o despliegues antes de
 * escribir: comprobar que el contenido que recibe es exactamente el que se
 * firmó. Si el agente cambia una sola letra después de la firma, no coincide.
 */
export function contentMatches(action: AgentAction, content: string | Uint8Array): boolean {
  if (action.contentHash === undefined) {
    return false;
  }
  const actual = createHash('sha256').update(content).digest();
  const expected = Buffer.from(action.contentHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/** Añade el registro de ejecución a la acción (inmutable). */
export function appendExecutionRecord(
  action: AgentAction,
  execution: ExecutionResult,
  now: Date,
  idFactory: () => string,
): AgentAction {
  const record: DecisionRecord = {
    id: idFactory(),
    stage: 'execution',
    decision: execution.ok ? 'approved' : 'rejected',
    reason: execution.detail,
    by: execution.connector,
    at: now,
  };
  return { ...action, decisions: [...action.decisions, record] };
}
