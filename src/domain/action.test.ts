import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AgentActionSchema,
  applyHumanDecision,
  canTransition,
  expirePendingAction,
  InvalidTransitionError,
  RoleNotAuthorizedError,
  SignatureAlreadyPresentError,
  STATUS_TRANSITIONS,
} from './action.ts';

const baseInput = {
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
};

describe('AgentActionSchema — validación de entrada', () => {
  it('acepta una acción de pago bien formada y convierte las fechas', () => {
    const parsed = AgentActionSchema.safeParse({ ...baseInput, createdAt: '2026-10-26T10:00:00Z' });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.ok(parsed.data.createdAt instanceof Date);
      assert.equal(parsed.data.amountMinor, 2500);
    }
  });

  it('rechaza un pago sin importe', () => {
    const parsed = AgentActionSchema.safeParse({ ...baseInput, amountMinor: undefined });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.path.includes('amountMinor')));
    }
  });

  it('rechaza importes cero o negativos', () => {
    assert.equal(AgentActionSchema.safeParse({ ...baseInput, amountMinor: 0 }).success, false);
    assert.equal(AgentActionSchema.safeParse({ ...baseInput, amountMinor: -100 }).success, false);
  });

  it('rechaza códigos de moneda que no son ISO 4217', () => {
    assert.equal(AgentActionSchema.safeParse({ ...baseInput, currency: 'eur' }).success, false);
    assert.equal(AgentActionSchema.safeParse({ ...baseInput, currency: 'EURO' }).success, false);
  });

  it('rechaza justificaciones vacías o demasiado cortas', () => {
    assert.equal(AgentActionSchema.safeParse({ ...baseInput, justification: '' }).success, false);
    assert.equal(AgentActionSchema.safeParse({ ...baseInput, justification: 'porque sí' }).success, false);
  });

  it('rechaza tipos de acción desconocidos', () => {
    assert.equal(AgentActionSchema.safeParse({ ...baseInput, actionType: 'transfer' }).success, false);
  });

  it('acepta data_access sin importe', () => {
    const parsed = AgentActionSchema.safeParse({
      ...baseInput,
      actionType: 'data_access',
      amountMinor: undefined,
      destination: 'dataset:publico-ventas',
    });
    assert.equal(parsed.success, true);
  });
});

describe('máquina de estados', () => {
  it('permite exactamente las transiciones definidas', () => {
    assert.equal(canTransition('proposed', 'pending_signature'), true);
    assert.equal(canTransition('proposed', 'approved'), true);
    assert.equal(canTransition('proposed', 'rejected'), true);
    assert.equal(canTransition('proposed', 'expired'), false);

    assert.equal(canTransition('pending_signature', 'approved'), true);
    assert.equal(canTransition('pending_signature', 'rejected'), true);
    assert.equal(canTransition('pending_signature', 'expired'), true);
    assert.equal(canTransition('pending_signature', 'proposed'), false);
  });

  it('no permite salir de los estados terminales', () => {
    for (const status of ['approved', 'rejected', 'expired'] as const) {
      assert.equal(STATUS_TRANSITIONS[status].length, 0);
      assert.equal(canTransition(status, 'proposed'), false);
    }
  });
});

describe('expirePendingAction', () => {
  const pending = AgentActionSchema.parse({
    ...baseInput,
    status: 'pending_signature',
    expiresAt: new Date('2026-10-26T10:15:00Z'),
  });

  it('expira una solicitud vencida y deja constancia', () => {
    const result = expirePendingAction(pending, new Date('2026-10-26T10:16:00Z'), () => 'r-expired');
    assert.equal(result.status, 'expired');
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0]?.decision, 'expired');
    assert.equal(result.decisions[0]?.by, 'system');
  });

  it('no toca solicitudes que aún están en plazo', () => {
    const result = expirePendingAction(pending, new Date('2026-10-26T10:14:00Z'));
    assert.strictEqual(result, pending);
  });
});

describe('applyHumanDecision', () => {
  const pending = AgentActionSchema.parse({
    ...baseInput,
    status: 'pending_signature',
    expiresAt: new Date('2026-10-26T10:15:00Z'),
  });
  const proposed = AgentActionSchema.parse(baseInput);

  it('aprueba una acción pendiente y registra la llave que firmó', () => {
    const result = applyHumanDecision(
      pending,
      'approved',
      'cred-abc',
      'maria',
      'autorizador',
      new Date('2026-10-26T10:05:00Z'),
      () => 'r-firma',
    );
    assert.equal(result.status, 'approved');
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0]?.stage, 'signature');
    assert.equal(result.decisions[0]?.decision, 'approved');
    assert.equal(result.decisions[0]?.by, 'cred-abc');
    assert.ok(result.decisions[0]?.reason?.includes('cred-abc'));
  });

  it('rechaza decisiones sobre acciones que no están pendientes', () => {
    assert.throws(() => applyHumanDecision(proposed, 'approved', 'cred-abc', 'maria', 'autorizador'), InvalidTransitionError);
    assert.throws(
      () =>
        applyHumanDecision(
          AgentActionSchema.parse({ ...baseInput, status: 'approved' }),
          'rejected',
          'cred-abc',
          'maria',
          'autorizador',
        ),
      InvalidTransitionError,
    );
  });

  it('no muta la acción original', () => {
    applyHumanDecision(pending, 'rejected', 'cred-abc', 'maria', 'autorizador');
    assert.equal(pending.status, 'pending_signature');
    assert.equal(pending.decisions.length, 0);
  });

  it('cuarto ojos: la primera firma deja la acción pendiente', () => {
    const two = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      signatures: [],
    });
    const result = applyHumanDecision(two, 'approved', 'llave-maria', 'maria', 'autorizador', new Date('2026-10-26T10:05:00Z'), () => 'r-1');
    assert.equal(result.status, 'pending_signature');
    assert.equal(result.signatures?.length, 1);
    assert.equal(result.signatures?.[0]?.userId, 'maria');
    assert.equal(result.decisions.length, 1);
  });

  it('cuarto ojos: la segunda firma de OTRA persona aprueba', () => {
    const partial = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      signatures: [{ keyId: 'llave-maria', userId: 'maria', role: 'autorizador', at: new Date('2026-10-26T10:05:00Z') }],
    });
    const result = applyHumanDecision(partial, 'approved', 'llave-carlos', 'carlos', 'autorizador', new Date('2026-10-26T10:06:00Z'), () => 'r-2');
    assert.equal(result.status, 'approved');
    assert.equal(result.signatures?.length, 2);
  });

  it('cuarto ojos: la misma llave no cuenta dos veces', () => {
    const partial = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      signatures: [{ keyId: 'llave-maria', userId: 'maria', role: 'autorizador', at: new Date('2026-10-26T10:05:00Z') }],
    });
    assert.throws(
      () => applyHumanDecision(partial, 'approved', 'llave-maria', 'maria', 'autorizador'),
      SignatureAlreadyPresentError,
    );
  });

  it('cuarto ojos: dos llaves de la MISMA persona no cuentan como dos firmas', () => {
    const partial = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      signatures: [{ keyId: 'llave-maria-movil', userId: 'maria', role: 'autorizador', at: new Date('2026-10-26T10:05:00Z') }],
    });
    assert.throws(
      () => applyHumanDecision(partial, 'approved', 'llave-maria-portatil', 'maria', 'autorizador'),
      SignatureAlreadyPresentError,
    );
  });

  it('cuarto ojos: un rechazo es veto, tenga las firmas que tenga', () => {
    const partial = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      signatures: [{ keyId: 'llave-maria', userId: 'maria', role: 'autorizador', at: new Date('2026-10-26T10:05:00Z') }],
    });
    const result = applyHumanDecision(partial, 'rejected', 'llave-carlos', 'carlos', 'autorizador');
    assert.equal(result.status, 'rejected');
  });

  it('cuarto ojos por roles: un empleado no puede firmar una acción de autorizadores', () => {
    const two = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      requiredRoles: ['autorizador'],
      signatures: [],
    });
    assert.throws(
      () => applyHumanDecision(two, 'approved', 'llave-carlos', 'carlos', 'empleado'),
      RoleNotAuthorizedError,
    );
    try {
      applyHumanDecision(two, 'approved', 'llave-carlos', 'carlos', 'empleado');
    } catch (err) {
      assert.equal((err as RoleNotAuthorizedError).status, 403);
    }
  });

  it('cuarto ojos por roles: el veto de un empleado tampoco vale', () => {
    const two = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      requiredRoles: ['autorizador'],
      signatures: [],
    });
    assert.throws(
      () => applyHumanDecision(two, 'rejected', 'llave-carlos', 'carlos', 'empleado'),
      RoleNotAuthorizedError,
    );
  });

  it('cuarto ojos por roles: dos autorizadores distintos completan el quórum', () => {
    const partial = AgentActionSchema.parse({
      ...baseInput,
      status: 'pending_signature',
      requiredSignatures: 2,
      requiredRoles: ['autorizador'],
      signatures: [{ keyId: 'llave-maria', userId: 'maria', role: 'autorizador', at: new Date('2026-10-26T10:05:00Z') }],
    });
    const result = applyHumanDecision(
      partial,
      'approved',
      'llave-ana',
      'ana',
      'autorizador',
      new Date('2026-10-26T10:06:00Z'),
      () => 'r-3',
    );
    assert.equal(result.status, 'approved');
    assert.equal(result.signatures?.length, 2);
    assert.equal(result.signatures?.[1]?.role, 'autorizador');
  });
});

describe('tipos no monetarios (validación)', () => {
  it('los tipos monetarios exigen moneda', () => {
    const { currency: _c, ...rest } = baseInput;
    const parsed = AgentActionSchema.safeParse(rest);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.path.includes('currency')));
    }
  });

  it('file_change exige operation pero no importe ni moneda', () => {
    const valid = AgentActionSchema.safeParse({
      ...baseInput,
      actionType: 'file_change',
      amountMinor: undefined,
      currency: undefined,
      operation: 'modify',
      contentHash: 'c0ffee'.repeat(10) + 'c0ff',
    });
    assert.equal(valid.success, true);

    const sinOperacion = AgentActionSchema.safeParse({
      ...baseInput,
      actionType: 'file_change',
      amountMinor: undefined,
      currency: undefined,
    });
    assert.equal(sinOperacion.success, false);
  });

  it('program_change también exige operation', () => {
    const parsed = AgentActionSchema.safeParse({
      ...baseInput,
      actionType: 'program_change',
      amountMinor: undefined,
      currency: undefined,
    });
    assert.equal(parsed.success, false);
  });

  const fileChange = (over: Record<string, unknown>) =>
    AgentActionSchema.safeParse({ ...baseInput, actionType: 'file_change', amountMinor: undefined, currency: undefined, ...over });

  it('solo acepta las operaciones de su tipo', () => {
    assert.equal(fileChange({ operation: 'borrar' }).success, false);
    assert.equal(fileChange({ operation: 'deploy', contentHash: 'ab'.repeat(32) }).success, false);
    assert.equal(fileChange({ operation: 'delete' }).success, true);
  });

  it('crear o modificar exige el hash del contenido; borrar no', () => {
    const sinHash = fileChange({ operation: 'create' });
    assert.equal(sinHash.success, false);
    if (!sinHash.success) {
      assert.ok(sinHash.error.issues.some((i) => i.path.includes('contentHash')));
    }
    assert.equal(fileChange({ operation: 'modify', contentHash: 'no-es-un-hash' }).success, false);
    assert.equal(fileChange({ operation: 'modify', contentHash: 'AB'.repeat(32) }).success, false);
    assert.equal(fileChange({ operation: 'modify', contentHash: 'ab'.repeat(32) }).success, true);
  });
});
