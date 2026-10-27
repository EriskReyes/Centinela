/**
 * Fase 3 — Repositorio sobre MongoDB.
 */
import type { AgentAction } from '../domain/action.ts';
import { ActionModel, actionToDoc, docToAction, type ActionDoc } from '../db/models.ts';
import type { ActionListFilter, ActionRepository } from './repository.ts';

export class MongoActionRepository implements ActionRepository {
  async insert(action: AgentAction): Promise<void> {
    await ActionModel.create(actionToDoc(action));
  }

  async replace(action: AgentAction): Promise<boolean> {
    const result = await ActionModel.replaceOne({ _id: action.id }, actionToDoc(action));
    return result.modifiedCount === 1;
  }

  async findById(id: string): Promise<AgentAction | null> {
    const doc = (await ActionModel.findById(id).lean()) as unknown as ActionDoc | null;
    return doc === null ? null : docToAction(doc);
  }

  async findByMetadataKey(key: string): Promise<AgentAction | null> {
    const doc = (await ActionModel.findOne({ 'metadata.idempotencyKey': key }).lean()) as unknown as ActionDoc | null;
    return doc === null ? null : docToAction(doc);
  }

  async list(filter: ActionListFilter): Promise<AgentAction[]> {
    const query: Record<string, string> = {};
    if (filter.status !== undefined) {
      query.status = filter.status;
    }
    if (filter.agentId !== undefined) {
      query.agentId = filter.agentId;
    }
    if (filter.actionType !== undefined) {
      query.actionType = filter.actionType;
    }
    const docs = (await ActionModel.find(query).sort({ createdAt: -1 }).limit(filter.limit).lean()) as unknown as ActionDoc[];
    return docs.map(docToAction);
  }

  async listPending(): Promise<AgentAction[]> {
    const docs = (await ActionModel.find({ status: 'pending_signature' }).sort({ createdAt: 1 }).lean()) as unknown as ActionDoc[];
    return docs.map(docToAction);
  }
}
