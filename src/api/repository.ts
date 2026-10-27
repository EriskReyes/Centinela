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

export interface ActionRepository {
  insert(action: AgentAction): Promise<void>;
  /** Sustituye la acción completa si existe; devuelve false si no estaba. */
  replace(action: AgentAction): Promise<boolean>;
  findById(id: string): Promise<AgentAction | null>;
  findByMetadataKey(key: string): Promise<AgentAction | null>;
  list(filter: ActionListFilter): Promise<AgentAction[]>;
  listPending(): Promise<AgentAction[]>;
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

  async replace(action: AgentAction): Promise<boolean> {
    if (!this.byId.has(action.id)) {
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
}
