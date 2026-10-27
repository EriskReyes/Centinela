/**
 * Fase 3 — Fuente de la política vigente.
 *
 * En producción se lee de MongoDB (el panel de administración la editará en la
 * Fase 6); en los tests se usa una versión en memoria.
 */
import { PolicyModel } from '../db/models.ts';
import { DEFAULT_POLICY, PolicySchema, type Policy } from '../rules/policy.ts';

export interface PolicyProvider {
  get(): Promise<Policy>;
  /** Guarda una política NUEVA (el panel la versiona) y la devuelve. */
  set(policy: Policy): Promise<Policy>;
}

export class InMemoryPolicyProvider implements PolicyProvider {
  private policy: Policy;

  constructor(policy: Policy = DEFAULT_POLICY) {
    this.policy = policy;
  }

  async get(): Promise<Policy> {
    return this.policy;
  }

  async set(policy: Policy): Promise<Policy> {
    this.policy = policy;
    return policy;
  }
}

export class MongoPolicyProvider implements PolicyProvider {
  async get(): Promise<Policy> {
    const docs = (await PolicyModel.find().sort({ version: -1 }).limit(1).lean()) as unknown as Policy[];
    if (docs.length === 0) {
      // Primera puesta en marcha: sembrar la política por defecto.
      try {
        await PolicyModel.create(DEFAULT_POLICY);
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) {
          throw err; // otra conexión ya la sembró: seguimos con la existente
        }
      }
      return DEFAULT_POLICY;
    }
    return PolicySchema.parse(docs[0]);
  }

  async set(policy: Policy): Promise<Policy> {
    await PolicyModel.create(policy);
    return policy;
  }
}
