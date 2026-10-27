import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, PolicySchema } from './policy.ts';

describe('PolicySchema', () => {
  it('acepta la política por defecto', () => {
    assert.equal(PolicySchema.safeParse(DEFAULT_POLICY).success, true);
  });

  it('rechaza versiones no positivas', () => {
    assert.equal(PolicySchema.safeParse({ ...DEFAULT_POLICY, version: 0 }).success, false);
    assert.equal(PolicySchema.safeParse({ ...DEFAULT_POLICY, version: -3 }).success, false);
  });

  it('rechaza límites negativos', () => {
    const bad = {
      ...DEFAULT_POLICY,
      types: {
        ...DEFAULT_POLICY.types,
        payment: { ...DEFAULT_POLICY.types.payment, allowLimitMinor: -5 },
      },
    };
    assert.equal(PolicySchema.safeParse(bad).success, false);
  });

  it('rechaza monedas que no son ISO 4217', () => {
    const bad = {
      ...DEFAULT_POLICY,
      types: {
        ...DEFAULT_POLICY.types,
        payment: { ...DEFAULT_POLICY.types.payment, currencies: ['EUR', 'euro'] },
      },
    };
    assert.equal(PolicySchema.safeParse(bad).success, false);
  });

  it('rechaza políticas a las que les falta un tipo obligatorio', () => {
    const { loan: _loan, ...types } = DEFAULT_POLICY.types;
    const bad = { ...DEFAULT_POLICY, types };
    assert.equal(PolicySchema.safeParse(bad).success, false);
  });

  it('rechaza límites incoherentes (firma ≤ aprobación automática)', () => {
    const bad = {
      ...DEFAULT_POLICY,
      types: {
        ...DEFAULT_POLICY.types,
        payment: { ...DEFAULT_POLICY.types.payment, allowLimitMinor: 100_00, signLimitMinor: 100_00 },
      },
    };
    const parsed = PolicySchema.safeParse(bad);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.path.join('.').includes('signLimitMinor')));
    }
  });

  it('rechaza un quórum sin número de firmas', () => {
    const bad = {
      ...DEFAULT_POLICY,
      types: {
        ...DEFAULT_POLICY.types,
        payment: { ...DEFAULT_POLICY.types.payment, quorumAboveMinor: 500_00, quorumSignatures: undefined },
      },
    };
    const parsed = PolicySchema.safeParse(bad);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.path.join('.').includes('quorumSignatures')));
    }
  });

  it('rechaza un umbral de quórum fuera de la banda de firma', () => {
    const bad = {
      ...DEFAULT_POLICY,
      types: {
        ...DEFAULT_POLICY.types,
        payment: { ...DEFAULT_POLICY.types.payment, quorumAboveMinor: 2_000_00, quorumSignatures: 2 },
      },
    };
    const parsed = PolicySchema.safeParse(bad);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.path.join('.').includes('quorumAboveMinor')));
    }
  });

  it('rechaza roles de quórum sin número de firmas', () => {
    const bad = {
      ...DEFAULT_POLICY,
      types: {
        ...DEFAULT_POLICY.types,
        payment: { ...DEFAULT_POLICY.types.payment, quorumSignatures: undefined, quorumRoles: ['autorizador'] },
      },
    };
    const parsed = PolicySchema.safeParse(bad);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.path.join('.').includes('quorumSignatures')));
    }
  });
});

describe('PolicySchema — tope acumulado', () => {
  it('rechaza un tope acumulado sin ventana (y una ventana sin tope)', () => {
    const { cumulativeWindowMinutes: _w, ...sinVentana } = DEFAULT_POLICY.types.payment;
    const { cumulativeAllowLimitMinor: _l, ...sinTope } = DEFAULT_POLICY.types.payment;
    for (const payment of [sinVentana, sinTope]) {
      const parsed = PolicySchema.safeParse({ ...DEFAULT_POLICY, types: { ...DEFAULT_POLICY.types, payment } });
      assert.equal(parsed.success, false);
    }
  });

  it('acepta un tipo sin tope acumulado', () => {
    const { cumulativeWindowMinutes: _w, cumulativeAllowLimitMinor: _l, ...payment } = DEFAULT_POLICY.types.payment;
    assert.equal(PolicySchema.safeParse({ ...DEFAULT_POLICY, types: { ...DEFAULT_POLICY.types, payment } }).success, true);
  });
});
