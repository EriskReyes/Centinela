/**
 * Fase 3 — Contrato de persistencia de acciones.
 *
 * La API depende de esta interfaz, no de Mongoose: los tests usan la versión
 * en memoria y producción usa MongoActionRepository. Cambiar de almacén no
 * toca ni una línea de la API.
 */
import type { ActionStatus, AgentAction } from '../domain/action.ts';

export interface ActionListFilter {
  status?: ActionStatus;
  agentId?: string;
  actionType?: string;
  limit: number;
}

export interface AutoApprovedFilter {
  agentId: string;
  actionType: string;
  currency: string;
  since: Date;
}

/** ¿El motor la dejó pasar sin firma humana? */
export function wasAutoApproved(action: AgentAction): boolean {
  return action.decisions.some((d) => d.stage === 'engine' && d.decision === 'allow');
}

/**
 * Condición para sustituir (concurrencia optimista): la acción guardada debe
 * seguir como estaba cuando se leyó. Si dos personas firman a la vez, la
 * segunda escritura no pisa la firma de la primera: falla y se reintenta.
 */
export interface ReplaceExpectation {
  status: ActionStatus;
  /** Número de firmas parciales que tenía al leerla. */
  signatureCount?: number;
  /** false → solo si todavía no pasó por un conector. */
  executed?: boolean;
}

export function meetsExpectation(current: AgentAction, expected: ReplaceExpectation): boolean {
  return (
    current.status === expected.status &&
    (expected.signatureCount === undefined || (current.signatures?.length ?? 0) === expected.signatureCount) &&
    (expected.executed === undefined ||
      current.decisions.some((d) => d.stage === 'execution') === expected.executed)
  );
}

export interface ActionRepository {
  insert(action: AgentAction): Promise<void>;
  /**
   * Sustituye la acción completa si existe (y, si se pasa `expected`, si sigue
   * en ese estado); devuelve false si no estaba o alguien la cambió antes.
   */
  replace(action: AgentAction, expected?: ReplaceExpectation): Promise<boolean>;
  findById(id: string): Promise<AgentAction | null>;
  findByMetadataKey(key: string): Promise<AgentAction | null>;
  list(filter: ActionListFilter): Promise<AgentAction[]>;
  listPending(): Promise<AgentAction[]>;
  /** Suma de importes aprobados sin firma (tope acumulado del motor). */
  sumAutoApproved(filter: AutoApprovedFilter): Promise<number>;
}

export class InMemoryActionRepository implements ActionRepository {
  private readonly byId = new Map<string, AgentAction>();

  async insert(action: AgentAction): Promise<void> {
    if (this.byId.has(action.id)) {
      throw Object.assign(new Error(`acción duplicada: ${action.id}`), { code: 11000 });
    }
    // Réplica del índice único sparse de Mongo: dos envíos con la misma clave de
    // idempotencia no pueden crear dos acciones (ni siquiera en paralelo).
    const idempotencyKey = action.metadata?.idempotencyKey;
    if (typeof idempotencyKey === 'string') {
      for (const existing of this.byId.values()) {
        if (existing.metadata?.idempotencyKey === idempotencyKey) {
          throw Object.assign(new Error(`clave de idempotencia duplicada: ${idempotencyKey}`), { code: 11000 });
        }
      }
    }
    this.byId.set(action.id, action);
  }

  async replace(action: AgentAction, expected?: ReplaceExpectation): Promise<boolean> {
    const current = this.byId.get(action.id);
    if (current === undefined || (expected !== undefined && !meetsExpectation(current, expected))) {
      return false;
    }
    this.byId.set(action.id, action);
    return true;
  }

  async findById(id: string): Promise<AgentAction | null> {
    return this.byId.get(id) ?? null;
  }

  async findByMetadataKey(key: string): Promise<AgentAction | null> {
    for (const action of this.byId.values()) {
      if (action.metadata?.idempotencyKey === key) {
        return action;
      }
    }
    return null;
  }

  async list(filter: ActionListFilter): Promise<AgentAction[]> {
    const result = [...this.byId.values()].filter(
      (action) =>
        (filter.status === undefined || action.status === filter.status) &&
        (filter.agentId === undefined || action.agentId === filter.agentId) &&
        (filter.actionType === undefined || action.actionType === filter.actionType),
    );
    result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return result.slice(0, filter.limit);
  }

  async listPending(): Promise<AgentAction[]> {
    const result = [...this.byId.values()].filter((action) => action.status === 'pending_signature');
    result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return result;
  }

  async sumAutoApproved(filter: AutoApprovedFilter): Promise<number> {
    let total = 0;
    for (const action of this.byId.values()) {
      if (
        action.agentId === filter.agentId &&
        action.actionType === filter.actionType &&
        action.currency === filter.currency &&
        action.createdAt >= filter.since &&
        wasAutoApproved(action)
      ) {
        total += action.amountMinor ?? 0;
      }
    }
    return total;
  }
}
