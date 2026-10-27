import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentActionSchema } from '../domain/action.ts';
import { ActionModel, actionToDoc, docToAction, PolicyModel } from './models.ts';
import { DEFAULT_POLICY } from '../rules/policy.ts';

const sample = AgentActionSchema.parse({
  id: randomUUID(),
  agentId: 'agente-compras',
  actionType: 'payment',
  amountMinor: 25_00,
  currency: 'EUR',
  destination: 'amazon.es',
  justification: 'Compra de material de oficina aprobada en presupuesto mensual',
  status: 'proposed',
  createdAt: new Date('2026-10-26T10:00:00Z'),
  decisions: [],
});

describe('mapeos dominio ↔ Mongo', () => {
  it('actionToDoc y docToAction son inversos', () => {
    const doc = actionToDoc(sample);
    assert.equal(doc._id, sample.id);
    assert.equal('id' in doc, false);
    assert.deepEqual(docToAction(doc), sample);
  });
});

describe('ActionModel (validación sin conexión)', () => {
  it('acepta un documento completo', async () => {
    const doc = new ActionModel(actionToDoc(sample));
    await doc.validate();
  });

  it('rechaza documentos sin agente', async () => {
    const doc = new ActionModel({ ...actionToDoc(sample), agentId: undefined });
    await assert.rejects(() => doc.validate());
  });

  it('rechaza estados fuera del enum', async () => {
    const doc = new ActionModel({ ...actionToDoc(sample), status: 'pirateado' });
    await assert.rejects(() => doc.validate());
  });

  it('rechaza decisiones con stage desconocido', async () => {
    const doc = new ActionModel({
      ...actionToDoc(sample),
      decisions: [{ id: 'r-1', stage: 'trucado', decision: 'allow', by: 'rules-engine', at: new Date() }],
    });
    await assert.rejects(() => doc.validate());
  });
});

describe('PolicyModel (validación sin conexión)', () => {
  it('acepta la política por defecto', async () => {
    const doc = new PolicyModel(DEFAULT_POLICY);
    await doc.validate();
  });
});
