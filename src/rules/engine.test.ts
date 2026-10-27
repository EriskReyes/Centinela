import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentActionSchema, type AgentAction, type NewAgentActionInput } from '../domain/action.ts';
import { DEFAULT_POLICY, type Policy } from './policy.ts';
import { applyEngineDecision, evaluateAction, matchesPattern } from './engine.ts';

/** Fabrica una acción de pago válida; los overrides se validan igual que en producción. */
function makeAction(overrides: Partial<NewAgentActionInput> = {}): AgentAction {
  const input: NewAgentActionInput = {
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
  };
  const parsed = AgentActionSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`acción de prueba inválida: ${parsed.error.message}`);
  }
  return parsed.data;
}

describe('evaluateAction — motor de reglas', () => {
  it('permite un pago pequeño a un destino de confianza', () => {
    const result = evaluateAction(makeAction({ amountMinor: 25_00, destination: 'amazon.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'allow');
    assert.deepEqual(result.reasons, []);
  });

  it('exige firma cuando el importe supera el límite de aprobación automática', () => {
    const result = evaluateAction(makeAction({ amountMinor: 500_00, destination: 'amazon.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'sign');
    assert.ok(result.reasons.join(' ').includes('límite de aprobación automática'));
  });

  it('bloquea importes por encima del límite máximo, aunque el destino sea de confianza', () => {
    const result = evaluateAction(makeAction({ amountMinor: 2_000_00, destination: 'amazon.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
  });

  it('respeta los límites exactos de la política', () => {
    const trusted = { destination: 'amazon.es' };
    // 100_00 = 100,00 EUR (límite allow): justo en el límite se permite.
    assert.equal(evaluateAction(makeAction({ ...trusted, amountMinor: 100_00 }), DEFAULT_POLICY).decision, 'allow');
    // 1_000_00 = 1.000,00 EUR (límite sign): justo en el límite se firma.
    assert.equal(evaluateAction(makeAction({ ...trusted, amountMinor: 1_000_00 }), DEFAULT_POLICY).decision, 'sign');
    // Un centavo por encima: se bloquea.
    assert.equal(evaluateAction(makeAction({ ...trusted, amountMinor: 1_000_01 }), DEFAULT_POLICY).decision, 'block');
  });

  it('aplica límites distintos por tipo (reservation)', () => {
    const reservation = (amountMinor: number) =>
      makeAction({ actionType: 'reservation', amountMinor, destination: 'adobe.com' });
    assert.equal(evaluateAction(reservation(50_00), DEFAULT_POLICY).decision, 'allow');
    assert.equal(evaluateAction(reservation(400_00), DEFAULT_POLICY).decision, 'sign');
    assert.equal(evaluateAction(reservation(600_00), DEFAULT_POLICY).decision, 'block');
  });

  it('bloquea tipos deshabilitados por la política (loan)', () => {
    const result = evaluateAction(makeAction({ actionType: 'loan', amountMinor: 100_00 }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('deshabilitado'));
  });

  it('bloquea monedas no admitidas por la política', () => {
    const result = evaluateAction(makeAction({ currency: 'GBP' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('GBP'));
  });

  it('bloquea destinos prohibidos por patrón', () => {
    const result = evaluateAction(makeAction({ destination: 'crypto:binance' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('prohibido'));
  });

  it('exige firma para destinos que no están en la lista de confianza', () => {
    const result = evaluateAction(makeAction({ destination: 'proveedor-nuevo.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'sign');
    assert.ok(result.reasons.join(' ').includes('lista de confianza'));
  });

  it('permite leer datasets públicos, frena los sensibles y bloquea los secretos', () => {
    const dataset = (destination: string) => makeAction({ actionType: 'data_access', amountMinor: undefined, destination });

    assert.equal(evaluateAction(dataset('dataset:publico-ventas'), DEFAULT_POLICY).decision, 'allow');
    assert.equal(evaluateAction(dataset('dataset:clientes-pii'), DEFAULT_POLICY).decision, 'sign');
    assert.equal(evaluateAction(dataset('dataset:secretos-nominas'), DEFAULT_POLICY).decision, 'block');
  });

  it('bloquea importes negativos aunque la validación ya los haya rechazado (defensa en profundidad)', () => {
    const action = { ...makeAction(), amountMinor: -5 } as AgentAction;
    const result = evaluateAction(action, DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('importe inválido'));
  });

  it('bloquea acciones monetarias forjadas sin importe (defensa en profundidad)', () => {
    const action = { ...makeAction(), amountMinor: undefined } as AgentAction;
    const result = evaluateAction(action, DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('no trae importe'));
  });

  it('bloquea un tipo de acción que no existe (defensa en profundidad)', () => {
    const action = { ...makeAction(), actionType: 'transfer' } as unknown as AgentAction;
    assert.equal(evaluateAction(action, DEFAULT_POLICY).decision, 'block');
  });

  it('se niega a evaluar algo que no sea una propuesta nueva (anti-replay temprano)', () => {
    const action = makeAction({ status: 'approved' });
    const result = evaluateAction(action, DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes("'proposed'"));
  });

  it('registra con qué versión de política se decidió (trazabilidad)', () => {
    const custom: Policy = { ...DEFAULT_POLICY, version: 7 };
    assert.equal(evaluateAction(makeAction(), custom).policyVersion, 7);
  });

  it('cuarto ojos: el quórum depende del umbral dentro de la banda de firma', () => {
    // 500,00 €: justo en el umbral → una firma basta.
    const atThreshold = evaluateAction(makeAction({ amountMinor: 500_00 }), DEFAULT_POLICY);
    assert.equal(atThreshold.decision, 'sign');
    assert.equal(atThreshold.requiredSignatures, 1);
    // 700,00 €: por encima del umbral → dos firmas.
    const above = evaluateAction(makeAction({ amountMinor: 700_00 }), DEFAULT_POLICY);
    assert.equal(above.decision, 'sign');
    assert.equal(above.requiredSignatures, 2);
  });

  it('cuarto ojos por roles: la política exige autorizadores en TODA firma', () => {
    const atThreshold = evaluateAction(makeAction({ amountMinor: 500_00 }), DEFAULT_POLICY);
    assert.deepEqual(atThreshold.requiredRoles, ['autorizador']);
    const above = evaluateAction(makeAction({ amountMinor: 700_00 }), DEFAULT_POLICY);
    assert.deepEqual(above.requiredRoles, ['autorizador']);
    const allow = evaluateAction(makeAction({ amountMinor: 25_00 }), DEFAULT_POLICY);
    assert.equal(allow.requiredRoles, undefined);
  });

  it('allow y block no exigen firmas', () => {
    assert.equal(evaluateAction(makeAction({ amountMinor: 25_00 }), DEFAULT_POLICY).requiredSignatures, undefined);
    assert.equal(
      evaluateAction(makeAction({ destination: 'crypto:binance' }), DEFAULT_POLICY).requiredSignatures,
      undefined,
    );
  });
});

describe('matchesPattern', () => {
  it('coincide por prefijo con * y de forma exacta sin *', () => {
    assert.equal(matchesPattern('crypto:binance', 'crypto:*'), true);
    assert.equal(matchesPattern('crypto:binance', 'crypto:'), false);
    assert.equal(matchesPattern('amazon.es', 'amazon.es'), true);
    assert.equal(matchesPattern('amazon.es', 'amazon.*'), true);
    assert.equal(matchesPattern('x-amazon.es', 'amazon.*'), false);
  });
});

describe('applyEngineDecision', () => {
  const now = new Date('2026-10-26T10:00:00Z');

  it("convierte 'sign' en una solicitud pendiente con vencimiento y registro", () => {
    const action = makeAction({ amountMinor: 500_00 });
    const result = evaluateAction(action, DEFAULT_POLICY);
    assert.equal(result.decision, 'sign');

    const updated = applyEngineDecision(action, result, now, () => 'r-1');
    assert.equal(updated.status, 'pending_signature');
    assert.deepEqual(updated.expiresAt, new Date(now.getTime() + 15 * 60_000));
    assert.deepEqual(updated.decidedAt, now);
    assert.equal(updated.decisions.length, 1);
    const record = updated.decisions[0];
    assert.ok(record);
    assert.equal(record.id, 'r-1');
    assert.equal(record.stage, 'engine');
    assert.equal(record.decision, 'sign');
    assert.equal(record.by, 'rules-engine');
    assert.deepEqual(record.at, now);
    assert.ok(record.reason?.includes('límite de aprobación automática'));
  });

  it("convierte 'allow' en aprobada y 'block' en rechazada", () => {
    const allowed = makeAction();
    const allowedResult = evaluateAction(allowed, DEFAULT_POLICY);
    const updated = applyEngineDecision(allowed, allowedResult, now, () => 'r-2');
    assert.equal(updated.status, 'approved');
    assert.equal(updated.decisions[0]?.decision, 'allow');

    const blocked = makeAction({ destination: 'crypto:binance' });
    const blockedResult = evaluateAction(blocked, DEFAULT_POLICY);
    const updatedBlocked = applyEngineDecision(blocked, blockedResult, now, () => 'r-3');
    assert.equal(updatedBlocked.status, 'rejected');
    assert.equal(updatedBlocked.decisions[0]?.decision, 'block');
    assert.ok(updatedBlocked.decisions[0]?.reason?.includes('prohibido'));
  });

  it('no muta la acción original (inmutabilidad, clave para la auditoría)', () => {
    const action = makeAction();
    const result = evaluateAction(action, DEFAULT_POLICY);
    applyEngineDecision(action, result, now, () => 'r-4');
    assert.equal(action.status, 'proposed');
    assert.equal(action.decisions.length, 0);
  });

  it('la pendiente nace con su exigencia de firmas y cero recibidas', () => {
    const action = makeAction({ amountMinor: 700_00 });
    const result = evaluateAction(action, DEFAULT_POLICY);
    const updated = applyEngineDecision(action, result, now, () => 'r-5');
    assert.equal(updated.status, 'pending_signature');
    assert.equal(updated.requiredSignatures, 2);
    assert.deepEqual(updated.requiredRoles, ['autorizador']);
    assert.deepEqual(updated.signatures, []);
  });
});
