/**
 * Ejecución de una acción ya APROBADA (por el motor o por las firmas).
 *
 * Orden: la acción aprobada ya está guardada ANTES de llamar al conector.
 * Si se ejecutara primero y después fallara el guardado, el dinero saldría
 * (o el archivo se escribiría) sin dejar rastro. Así, lo peor que puede pasar
 * es una acción aprobada con la ejecución pendiente, visible en el panel.
 */
import type { AgentAction } from '../domain/action.ts';
import type { ActionRepository } from '../api/repository.ts';
import type { AuditService } from '../audit/service.ts';
import { appendExecutionRecord, executeAction, type ExecutionResult } from './connector.ts';

export interface ExecutorDeps {
  repository: ActionRepository;
  execute?: (action: AgentAction, now: Date) => ExecutionResult;
  audit?: AuditService;
  now: () => Date;
  idFactory: () => string;
}

/** ¿Ya pasó por un conector? (evita ejecutar dos veces la misma acción). */
export function wasExecuted(action: AgentAction): boolean {
  return action.decisions.some((d) => d.stage === 'execution');
}

export async function executeApproved(
  action: AgentAction,
  deps: ExecutorDeps,
): Promise<{ action: AgentAction; execution: ExecutionResult }> {
  if (action.status !== 'approved' || wasExecuted(action)) {
    throw new Error(`la acción ${action.id} no está aprobada o ya se ejecutó`);
  }
  const execute = deps.execute ?? executeAction;
  let execution: ExecutionResult;
  try {
    execution = execute(action, deps.now());
  } catch (err) {
    execution = { ok: false, connector: 'desconocido', detail: `el conector falló: ${err instanceof Error ? err.message : String(err)}` };
  }
  const executed = appendExecutionRecord(action, execution, deps.now(), deps.idFactory);
  await deps.repository.replace(executed, { status: 'approved', executed: false });
  await deps.audit?.append({
    eventType: 'action_executed',
    actionId: executed.id,
    actor: execution.connector,
    decision: execution.ok ? 'approved' : 'rejected',
    statusBefore: action.status,
    statusAfter: executed.status,
    reason: execution.detail,
    at: deps.now(),
  });
  return { action: executed, execution };
}
