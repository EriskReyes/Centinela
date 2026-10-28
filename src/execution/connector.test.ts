import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AgentActionSchema } from '../domain/action.ts';
import { appendExecutionRecord, contentMatches, executeAction } from './connector.ts';

function makeAction(overrides: Record<string, unknown> = {}) {
  const parsed = AgentActionSchema.safeParse({
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
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return parsed.data;
}

describe('executeAction', () => {
  it('simula un pago con detalle legible', () => {
    const result = executeAction(makeAction({ amountMinor: 25_00, destination: 'amazon.es' }));
    assert.equal(result.ok, true);
    assert.equal(result.connector, 'simulador-pagos');
    assert.ok(result.detail.includes('25.00 EUR'));
    assert.ok(result.detail.includes('amazon.es'));
  });

  it('simula reservas y lecturas de datos', () => {
    const reservation = executeAction(makeAction({ actionType: 'reservation', amountMinor: 120_00 }));
    assert.equal(reservation.ok, true);
    assert.equal(reservation.connector, 'simulador-reservas');

    const read = executeAction(
      makeAction({ actionType: 'data_access', amountMinor: undefined, destination: 'dataset:publico-ventas' }),
    );
    assert.equal(read.ok, true);
    assert.equal(read.connector, 'simulador-datos');
  });

  it('falla contra proveedores caídos (fallo simulado)', () => {
    const result = executeAction(makeAction({ destination: 'proveedor-caido.es' }));
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes('no respondió'));
  });

  it('rechaza tipos sin conector', () => {
    const result = executeAction(makeAction({ actionType: 'loan', amountMinor: 100_00 }));
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes('no tiene conector'));
  });
});

describe('appendExecutionRecord', () => {
  it('añade el registro de ejecución sin mutar la acción original', () => {
    const action = makeAction();
    const now = new Date('2026-10-26T10:01:00Z');
    const execution = executeAction(action);
    const updated = appendExecutionRecord(action, execution, now, () => 'x-1');

    assert.equal(action.decisions.length, 0);
    assert.equal(updated.decisions.length, 1);
    assert.deepEqual(updated.decisions[0], {
      id: 'x-1',
      stage: 'execution',
      decision: 'approved',
      reason: execution.detail,
      by: 'simulador-pagos',
      at: now,
    });
  });

  it('registra el fallo como decision rejected', () => {
    const action = makeAction({ destination: 'proveedor-caido.es' });
    const now = new Date('2026-10-26T10:02:00Z');
    const updated = appendExecutionRecord(action, executeAction(action), now, () => 'x-2');
    assert.equal(updated.decisions[0]?.decision, 'rejected');
  });
});

describe('tipos no monetarios', () => {
  it('simula cambios de archivo con su operación', () => {
    const file = executeAction(
      makeAction({ actionType: 'file_change', amountMinor: undefined, operation: 'modify', contentHash: 'c0ffee'.repeat(10) + 'c0ff', destination: 'repo:centinela/docs/x.md' }),
    );
    assert.equal(file.ok, true);
    assert.equal(file.connector, 'simulador-archivos');
    assert.ok(file.detail.includes('modify'));
    assert.ok(file.detail.includes('repo:centinela/docs/x.md'));
  });

  it('simula cambios de programa con su operación', () => {
    const program = executeAction(
      makeAction({ actionType: 'program_change', amountMinor: undefined, operation: 'deploy', contentHash: 'c0ffee'.repeat(10) + 'c0ff', destination: 'deploy:staging' }),
    );
    assert.equal(program.ok, true);
    assert.equal(program.connector, 'simulador-programa');
    assert.ok(program.detail.includes('deploy'));
    assert.ok(program.detail.includes('deploy:staging'));
  });
});

describe('contentMatches: el contenido escrito es el firmado', () => {
  const content = 'Guía actualizada con los límites nuevos del panel.\n';
  const hash = createHash('sha256').update(content).digest('hex');
  const action = makeAction({ actionType: 'file_change', amountMinor: undefined, operation: 'modify', contentHash: hash, destination: 'repo:centinela/docs/guia.md' });

  it('acepta exactamente el contenido firmado', () => {
    assert.equal(contentMatches(action, content), true);
    assert.equal(contentMatches(action, Buffer.from(content)), true);
  });

  it('rechaza cualquier cambio posterior a la firma', () => {
    assert.equal(contentMatches(action, content.replace('nuevos', 'nuevo')), false);
    assert.equal(contentMatches(action, content + ' '), false);
  });

  it('sin hash firmado, nunca coincide', () => {
    assert.equal(contentMatches({ ...action, contentHash: undefined }, content), false);
  });
});
