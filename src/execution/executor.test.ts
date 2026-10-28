import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentActionSchema, type AgentAction } from '../domain/action.ts';
import { InMemoryActionRepository, meetsExpectation } from '../api/repository.ts';
import { deriveIdempotencyKey } from '../api/idempotency.ts';
import { executeApproved, wasExecuted } from './executor.ts';
import type { ExecutionResult } from './connector.ts';

const NOW = new Date('2026-10-26T10:00:00Z');

function makeAction(overrides: Record<string, unknown> = {}): AgentAction {
  const parsed = AgentActionSchema.safeParse({
    id: randomUUID(),
    agentId: 'agente-compras',
    actionType: 'payment',
    amountMinor: 25_00,
    currency: 'EUR',
    destination: 'amazon.es',
    justification: 'Compra de material de oficina aprobada en presupuesto mensual',
    status: 'approved',
    createdAt: NOW,
    decisions: [],
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return parsed.data;
}

let counter = 0;
const deps = (repository: InMemoryActionRepository, execute?: (a: AgentAction) => ExecutionResult) => ({
  repository,
  execute,
  now: () => NOW,
  idFactory: () => `rec-${++counter}`,
});
const okExecution = (): ExecutionResult => ({ ok: true, connector: 'falso', detail: 'hecho' });

describe('executeApproved', () => {
  it('ejecuta una acción aprobada y guarda el registro de ejecución', async () => {
    const repository = new InMemoryActionRepository();
    const action = makeAction();
    await repository.insert(action);
    const { action: executed, execution } = await executeApproved(action, deps(repository, okExecution));
    assert.equal(execution.ok, true);
    assert.ok(wasExecuted(executed));
    const stored = await repository.findById(action.id);
    assert.ok(stored !== null && wasExecuted(stored));
  });

  it('si el conector lanza, la acción sigue guardada con la ejecución fallida', async () => {
    const repository = new InMemoryActionRepository();
    const action = makeAction();
    await repository.insert(action);
    const { execution } = await executeApproved(
      action,
      deps(repository, () => {
        throw new Error('timeout del banco');
      }),
    );
    assert.equal(execution.ok, false);
    assert.ok(execution.detail.includes('timeout del banco'));
    const stored = await repository.findById(action.id);
    assert.equal(stored?.status, 'approved');
    const record = stored?.decisions.find((d) => d.stage === 'execution');
    assert.equal(record?.decision, 'rejected');
  });

  it('no ejecuta una acción que no está aprobada', async () => {
    const repository = new InMemoryActionRepository();
    const action = makeAction({ status: 'pending_signature' });
    await repository.insert(action);
    let calls = 0;
    await assert.rejects(
      executeApproved(action, deps(repository, () => (calls++, okExecution()))),
      /no está aprobada/,
    );
    assert.equal(calls, 0);
  });

  it('no ejecuta dos veces la misma acción', async () => {
    const repository = new InMemoryActionRepository();
    const action = makeAction();
    await repository.insert(action);
    let calls = 0;
    const { action: executed } = await executeApproved(action, deps(repository, () => (calls++, okExecution())));
    await assert.rejects(executeApproved(executed, deps(repository, () => (calls++, okExecution()))), /ya se ejecutó/);
    assert.equal(calls, 1);
  });
});

describe('replace condicional (concurrencia optimista)', () => {
  const signature = { keyId: 'c1', userId: 'maria', role: 'autorizador', at: NOW };

  it('meetsExpectation compara estado, firmas y ejecución', () => {
    const action = makeAction({ status: 'pending_signature', signatures: [signature] });
    assert.equal(meetsExpectation(action, { status: 'pending_signature' }), true);
    assert.equal(meetsExpectation(action, { status: 'approved' }), false);
    assert.equal(meetsExpectation(action, { status: 'pending_signature', signatureCount: 1 }), true);
    assert.equal(meetsExpectation(action, { status: 'pending_signature', signatureCount: 0 }), false);
    assert.equal(meetsExpectation(action, { status: 'pending_signature', executed: false }), true);
    assert.equal(meetsExpectation(action, { status: 'pending_signature', executed: true }), false);
  });

  it('dos firmas simultáneas: la segunda no pisa a la primera', async () => {
    const repository = new InMemoryActionRepository();
    const pending = makeAction({ status: 'pending_signature' });
    await repository.insert(pending);

    // Las dos leyeron la acción con 0 firmas.
    const byMaria = { ...pending, signatures: [signature] };
    const byCarlos = { ...pending, signatures: [{ ...signature, keyId: 'c2', userId: 'carlos' }] };
    assert.equal(await repository.replace(byMaria, { status: 'pending_signature', signatureCount: 0 }), true);
    assert.equal(await repository.replace(byCarlos, { status: 'pending_signature', signatureCount: 0 }), false);

    const stored = await repository.findById(pending.id);
    assert.deepEqual(stored?.signatures?.map((s) => s.userId), ['maria']);
  });

  it('sin expectativa sustituye como antes', async () => {
    const repository = new InMemoryActionRepository();
    const action = makeAction();
    await repository.insert(action);
    assert.equal(await repository.replace({ ...action, status: 'rejected' }), true);
    assert.equal((await repository.findById(action.id))?.status, 'rejected');
  });
});

describe('clave de idempotencia derivada', () => {
  const file = {
    agentId: 'agente-dev',
    actionType: 'file_change',
    destination: 'repo:centinela/README.md',
    justification: 'Actualizar la documentación del proyecto',
  };

  it('un delete justo después de un modify del mismo archivo no es un reintento', () => {
    const modify = deriveIdempotencyKey({ ...file, operation: 'modify', contentHash: 'a'.repeat(64) }, NOW, 60);
    const del = deriveIdempotencyKey({ ...file, operation: 'delete' }, NOW, 60);
    assert.notEqual(modify, del);
  });

  it('el mismo cambio con otro contenido tampoco es un reintento', () => {
    const a = deriveIdempotencyKey({ ...file, operation: 'modify', contentHash: 'a'.repeat(64) }, NOW, 60);
    const b = deriveIdempotencyKey({ ...file, operation: 'modify', contentHash: 'b'.repeat(64) }, NOW, 60);
    assert.notEqual(a, b);
  });
});
