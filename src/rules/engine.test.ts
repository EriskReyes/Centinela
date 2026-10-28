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

/** Evalúa con un gasto previo sin firma en la ventana (0 por defecto: agente "limpio"). */
const evaluate = (action: AgentAction, policy: Policy, spentMinor = 0) =>
  evaluateAction(action, policy, { autoApprovedInWindowMinor: spentMinor });

describe('evaluateAction — motor de reglas', () => {
  it('permite un pago pequeño a un destino de confianza', () => {
    const result = evaluate(makeAction({ amountMinor: 25_00, destination: 'amazon.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'allow');
    assert.deepEqual(result.reasons, []);
  });

  it('exige firma cuando el importe supera el límite de aprobación automática', () => {
    const result = evaluate(makeAction({ amountMinor: 500_00, destination: 'amazon.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'sign');
    assert.ok(result.reasons.join(' ').includes('límite de aprobación automática'));
  });

  it('bloquea importes por encima del límite máximo, aunque el destino sea de confianza', () => {
    const result = evaluate(makeAction({ amountMinor: 2_000_00, destination: 'amazon.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
  });

  it('respeta los límites exactos de la política', () => {
    const trusted = { destination: 'amazon.es' };
    // 100_00 = 100,00 EUR (límite allow): justo en el límite se permite.
    assert.equal(evaluate(makeAction({ ...trusted, amountMinor: 100_00 }), DEFAULT_POLICY).decision, 'allow');
    // 1_000_00 = 1.000,00 EUR (límite sign): justo en el límite se firma.
    assert.equal(evaluate(makeAction({ ...trusted, amountMinor: 1_000_00 }), DEFAULT_POLICY).decision, 'sign');
    // Un centavo por encima: se bloquea.
    assert.equal(evaluate(makeAction({ ...trusted, amountMinor: 1_000_01 }), DEFAULT_POLICY).decision, 'block');
  });

  it('aplica límites distintos por tipo (reservation)', () => {
    const reservation = (amountMinor: number) =>
      makeAction({ actionType: 'reservation', amountMinor, destination: 'adobe.com' });
    assert.equal(evaluate(reservation(50_00), DEFAULT_POLICY).decision, 'allow');
    assert.equal(evaluate(reservation(400_00), DEFAULT_POLICY).decision, 'sign');
    assert.equal(evaluate(reservation(600_00), DEFAULT_POLICY).decision, 'block');
  });

  it('bloquea tipos deshabilitados por la política (loan)', () => {
    const result = evaluate(makeAction({ actionType: 'loan', amountMinor: 100_00 }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('deshabilitado'));
  });

  it('bloquea monedas no admitidas por la política', () => {
    const result = evaluate(makeAction({ currency: 'GBP' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('GBP'));
  });

  it('bloquea destinos prohibidos por patrón', () => {
    const result = evaluate(makeAction({ destination: 'crypto:binance' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('prohibido'));
  });

  it('exige firma para destinos que no están en la lista de confianza', () => {
    const result = evaluate(makeAction({ destination: 'proveedor-nuevo.es' }), DEFAULT_POLICY);
    assert.equal(result.decision, 'sign');
    assert.ok(result.reasons.join(' ').includes('lista de confianza'));
  });

  it('permite leer datasets públicos, frena los sensibles y bloquea los secretos', () => {
    const dataset = (destination: string) => makeAction({ actionType: 'data_access', amountMinor: undefined, destination });

    assert.equal(evaluate(dataset('dataset:publico-ventas'), DEFAULT_POLICY).decision, 'allow');
    assert.equal(evaluate(dataset('dataset:clientes-pii'), DEFAULT_POLICY).decision, 'sign');
    assert.equal(evaluate(dataset('dataset:secretos-nominas'), DEFAULT_POLICY).decision, 'block');
  });

  it('bloquea importes negativos aunque la validación ya los haya rechazado (defensa en profundidad)', () => {
    const action = { ...makeAction(), amountMinor: -5 } as AgentAction;
    const result = evaluate(action, DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('importe inválido'));
  });

  it('bloquea acciones monetarias forjadas sin importe (defensa en profundidad)', () => {
    const action = { ...makeAction(), amountMinor: undefined } as AgentAction;
    const result = evaluate(action, DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes('no trae importe'));
  });

  it('bloquea un tipo de acción que no existe (defensa en profundidad)', () => {
    const action = { ...makeAction(), actionType: 'transfer' } as unknown as AgentAction;
    assert.equal(evaluate(action, DEFAULT_POLICY).decision, 'block');
  });

  it('se niega a evaluar algo que no sea una propuesta nueva (anti-replay temprano)', () => {
    const action = makeAction({ status: 'approved' });
    const result = evaluate(action, DEFAULT_POLICY);
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.join(' ').includes("'proposed'"));
  });

  it('registra con qué versión de política se decidió (trazabilidad)', () => {
    const custom: Policy = { ...DEFAULT_POLICY, version: 7 };
    assert.equal(evaluate(makeAction(), custom).policyVersion, 7);
  });

  it('cuarto ojos: el quórum depende del umbral dentro de la banda de firma', () => {
    // 500,00 €: justo en el umbral → una firma basta.
    const atThreshold = evaluate(makeAction({ amountMinor: 500_00 }), DEFAULT_POLICY);
    assert.equal(atThreshold.decision, 'sign');
    assert.equal(atThreshold.requiredSignatures, 1);
    // 700,00 €: por encima del umbral → dos firmas.
    const above = evaluate(makeAction({ amountMinor: 700_00 }), DEFAULT_POLICY);
    assert.equal(above.decision, 'sign');
    assert.equal(above.requiredSignatures, 2);
  });

  it('cuarto ojos por roles: la política exige autorizadores en TODA firma', () => {
    const atThreshold = evaluate(makeAction({ amountMinor: 500_00 }), DEFAULT_POLICY);
    assert.deepEqual(atThreshold.requiredRoles, ['autorizador']);
    const above = evaluate(makeAction({ amountMinor: 700_00 }), DEFAULT_POLICY);
    assert.deepEqual(above.requiredRoles, ['autorizador']);
    const allow = evaluate(makeAction({ amountMinor: 25_00 }), DEFAULT_POLICY);
    assert.equal(allow.requiredRoles, undefined);
  });

  it('allow y block no exigen firmas', () => {
    assert.equal(evaluate(makeAction({ amountMinor: 25_00 }), DEFAULT_POLICY).requiredSignatures, undefined);
    assert.equal(
      evaluate(makeAction({ destination: 'crypto:binance' }), DEFAULT_POLICY).requiredSignatures,
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

  it('admite * en cualquier posición y, si se pide, ignora mayúsculas', () => {
    assert.equal(matchesPattern('repo:x/sub/.env.prod', '*/.env*'), true);
    assert.equal(matchesPattern('repo:x/docs/id_rsa.pub', '*id_rsa*'), true);
    assert.equal(matchesPattern('CRYPTO:binance', 'crypto:*'), false);
    assert.equal(matchesPattern('CRYPTO:binance', 'crypto:*', true), true);
    assert.equal(matchesPattern('a.b', 'a?b'), false);
  });
});

describe('evaluateAction — rutas peligrosas', () => {
  const file = (destination: string) =>
    evaluate(makeAction({ actionType: 'file_change', amountMinor: undefined, currency: undefined, operation: 'modify', contentHash: 'c0ffee'.repeat(10) + 'c0ff', destination }), DEFAULT_POLICY)
      .decision;

  it("'..' nunca pasa por estar dentro de una carpeta de confianza", () => {
    assert.equal(file('repo:centinela/docs/../.env'), 'block');
    assert.equal(file('repo:centinela\\docs\\..\\src\\auth.ts'), 'block');
  });

  it('.env, .ssh, .git, /etc y Windows se bloquean en cualquier carpeta y con cualquier grafía', () => {
    for (const destination of [
      '.env.produccion',
      'repo:centinela/.env',
      'repo:centinela/config/.ENV.local',
      '/home/u/.ssh/id_rsa',
      'repo:centinela/.git/config',
      '/etc/passwd',
      'c:/windows/system32/x.dll',
      'C:\\WINDOWS\\System32\\x.dll',
    ]) {
      assert.equal(file(destination), 'block', destination);
    }
  });

  it('las barras repetidas o invertidas no sacan una ruta de confianza de su carpeta', () => {
    assert.equal(file('repo:centinela//docs/./guia.md'), 'allow');
    assert.equal(file('repo:centinela\\docs\\guia.md'), 'allow');
  });

  it('los prohibidos de pagos tampoco distinguen mayúsculas', () => {
    assert.equal(evaluate(makeAction({ destination: 'CRYPTO:binance' }), DEFAULT_POLICY).decision, 'block');
  });

  it('un destino con caracteres de control se bloquea', () => {
    assert.equal(file('repo:centinela/docs/guia.md\u0000.sh'), 'block');
  });
});

describe('applyEngineDecision', () => {
  const now = new Date('2026-10-26T10:00:00Z');

  it("convierte 'sign' en una solicitud pendiente con vencimiento y registro", () => {
    const action = makeAction({ amountMinor: 500_00 });
    const result = evaluate(action, DEFAULT_POLICY);
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
    const allowedResult = evaluate(allowed, DEFAULT_POLICY);
    const updated = applyEngineDecision(allowed, allowedResult, now, () => 'r-2');
    assert.equal(updated.status, 'approved');
    assert.equal(updated.decisions[0]?.decision, 'allow');

    const blocked = makeAction({ destination: 'crypto:binance' });
    const blockedResult = evaluate(blocked, DEFAULT_POLICY);
    const updatedBlocked = applyEngineDecision(blocked, blockedResult, now, () => 'r-3');
    assert.equal(updatedBlocked.status, 'rejected');
    assert.equal(updatedBlocked.decisions[0]?.decision, 'block');
    assert.ok(updatedBlocked.decisions[0]?.reason?.includes('prohibido'));
  });

  it('no muta la acción original (inmutabilidad, clave para la auditoría)', () => {
    const action = makeAction();
    const result = evaluate(action, DEFAULT_POLICY);
    applyEngineDecision(action, result, now, () => 'r-4');
    assert.equal(action.status, 'proposed');
    assert.equal(action.decisions.length, 0);
  });

  it('la pendiente nace con su exigencia de firmas y cero recibidas', () => {
    const action = makeAction({ amountMinor: 700_00 });
    const result = evaluate(action, DEFAULT_POLICY);
    const updated = applyEngineDecision(action, result, now, () => 'r-5');
    assert.equal(updated.status, 'pending_signature');
    assert.equal(updated.requiredSignatures, 2);
    assert.deepEqual(updated.requiredRoles, ['autorizador']);
    assert.deepEqual(updated.signatures, []);
  });
});

describe('evaluateAction — tope acumulado sin firma', () => {
  // DEFAULT_POLICY: pagos de hasta 100,00 € sin firma, pero como mucho 300,00 € al día por agente.
  it('permite mientras el acumulado + el importe no supere el tope', () => {
    assert.equal(evaluate(makeAction({ amountMinor: 25_00 }), DEFAULT_POLICY, 275_00).decision, 'allow');
  });

  it('exige firma cuando un pago pequeño haría superar el tope', () => {
    const result = evaluate(makeAction({ amountMinor: 25_00 }), DEFAULT_POLICY, 280_00);
    assert.equal(result.decision, 'sign');
    assert.equal(result.requiredSignatures, 1);
    assert.ok(result.reasons.join(' ').includes('acumulado'));
  });

  it('sin tope acumulado en la política, el gasto previo no cuenta', () => {
    const { cumulativeWindowMinutes: _w, cumulativeAllowLimitMinor: _l, ...payment } = DEFAULT_POLICY.types.payment;
    const policy: Policy = { ...DEFAULT_POLICY, types: { ...DEFAULT_POLICY.types, payment } };
    assert.equal(evaluate(makeAction({ amountMinor: 25_00 }), policy, 10_000_00).decision, 'allow');
  });

  it('no afecta a data_access (no hay importe que sumar)', () => {
    const action = makeAction({ actionType: 'data_access', amountMinor: undefined, destination: 'dataset:publico-ventas' });
    assert.equal(evaluate(action, DEFAULT_POLICY, 10_000_00).decision, 'allow');
  });
});

describe('evaluateAction — tipos no monetarios (archivos y programa)', () => {
  const file = (destination: string, operation = 'modify') =>
    makeAction({ actionType: 'file_change', amountMinor: undefined, operation, contentHash: 'c0ffee'.repeat(10) + 'c0ff', destination });

  it('archivos: ruta de confianza → allow, ruta sensible → block, ruta nueva → sign', () => {
    assert.equal(evaluate(file('repo:centinela/docs/guia.md'), DEFAULT_POLICY).decision, 'allow');
    assert.equal(evaluate(file('.env.produccion'), DEFAULT_POLICY).decision, 'block');
    const nueva = evaluate(file('repo:centinela/src/nuevo.ts', 'create'), DEFAULT_POLICY);
    assert.equal(nueva.decision, 'sign');
    assert.equal(nueva.requiredSignatures, 1);
    // Los cambios de archivos solo los firma un autorizador, no cualquier empleado.
    assert.deepEqual(nueva.requiredRoles, ['autorizador']);
  });

  it('borrar pide firma aunque el archivo esté en una carpeta de confianza', () => {
    const borrar = evaluate(
      makeAction({ actionType: 'file_change', amountMinor: undefined, operation: 'delete', destination: 'repo:centinela/docs/guia.md' }),
      DEFAULT_POLICY,
    );
    assert.equal(borrar.decision, 'sign');
    assert.ok(borrar.reasons.join(' ').includes("'delete'"));
  });

  it('un despliegue pide firma aunque alguien marque su destino como de confianza', () => {
    const policy: Policy = { ...DEFAULT_POLICY, destinationTrusted: [...DEFAULT_POLICY.destinationTrusted, 'deploy:*'] };
    const deploy = evaluate(
      makeAction({ actionType: 'program_change', amountMinor: undefined, operation: 'deploy', contentHash: 'ab'.repeat(32), destination: 'deploy:staging' }),
      policy,
    );
    assert.equal(deploy.decision, 'sign');
    assert.equal(deploy.requiredSignatures, 2);
  });

  it('programa: TODO cambio exige dos autorizadores; producción bloqueada', () => {
    const staging = evaluate(
      makeAction({
        actionType: 'program_change',
        amountMinor: undefined,
        operation: 'deploy',
        contentHash: 'c0ffee'.repeat(10) + 'c0ff',
        destination: 'deploy:staging',
      }),
      DEFAULT_POLICY,
    );
    assert.equal(staging.decision, 'sign');
    assert.equal(staging.requiredSignatures, 2);
    assert.deepEqual(staging.requiredRoles, ['autorizador']);

    const prod = evaluate(
      makeAction({
        actionType: 'program_change',
        amountMinor: undefined,
        operation: 'deploy',
        contentHash: 'c0ffee'.repeat(10) + 'c0ff',
        destination: 'deploy:produccion',
      }),
      DEFAULT_POLICY,
    );
    assert.equal(prod.decision, 'block');
  });
});
