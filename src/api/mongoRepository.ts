/**
 * Fase 3 — Repositorio sobre MongoDB.
 */
import type { AgentAction } from '../domain/action.ts';
import { ActionModel, actionToDoc, docToAction, type ActionDoc } from '../db/models.ts';
import type { ActionListFilter, ActionRepository, AutoApprovedFilter, ReplaceExpectation } from './repository.ts';

export class MongoActionRepository implements ActionRepository {
  async insert(action: AgentAction): Promise<void> {
    await ActionModel.create(actionToDoc(action));
  }

  async replace(action: AgentAction, expected?: ReplaceExpectation): Promise<boolean> {
    // La condición va en el filtro: Mongo la comprueba y sustituye de forma atómica.
    const filter: Record<string, unknown> = { _id: action.id };
    if (expected !== undefined) {
      filter.status = expected.status;
      if (expected.signatureCount !== undefined) {
        filter.$and = [
          expected.signatureCount === 0
            ? { $or: [{ signatures: { $size: 0 } }, { signatures: { $exists: false } }] }
            : { signatures: { $size: expected.signatureCount } },
        ];
      }
      if (expected.executed !== undefined) {
        filter.decisions = expected.executed
          ? { $elemMatch: { stage: 'execution' } }
          : { $not: { $elemMatch: { stage: 'execution' } } };
      }
    }
    const result = await ActionModel.replaceOne(filter, actionToDoc(action));
    // matchedCount, no modifiedCount: sustituir por un documento idéntico también es éxito.
    return result.matchedCount === 1;
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

  async sumAutoApproved(filter: AutoApprovedFilter): Promise<number> {
    const [row] = await ActionModel.aggregate<{ total: number }>([
      {
        $match: {
          agentId: filter.agentId,
          actionType: filter.actionType,
          currency: filter.currency,
          createdAt: { $gte: filter.since },
          decisions: { $elemMatch: { stage: 'engine', decision: 'allow' } },
        },
      },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]);
    return row?.total ?? 0;
  }
}
