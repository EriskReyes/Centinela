import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY } from '../rules/policy.ts';
import { upgradeStoredPolicy } from './policyProvider.ts';

describe('upgradeStoredPolicy (políticas guardadas por versiones anteriores)', () => {
  const { file_change: _f, program_change: _p, ...oldTypes } = DEFAULT_POLICY.types;
  const oldPolicy = { ...DEFAULT_POLICY, version: 7, types: oldTypes };

  it('los tipos que no existían entran deshabilitados', () => {
    const upgraded = upgradeStoredPolicy(oldPolicy);
    assert.deepEqual(upgraded.types.file_change, { allowed: false });
    assert.deepEqual(upgraded.types.program_change, { allowed: false });
  });

  it('respeta lo que el admin ya había decidido', () => {
    const custom = {
      ...oldPolicy,
      types: { ...oldTypes, payment: { ...oldTypes.payment, allowed: false } },
    };
    const upgraded = upgradeStoredPolicy(custom);
    assert.equal(upgraded.version, 7);
    assert.equal(upgraded.types.payment?.allowed, false);
    assert.deepEqual(upgraded.types.reservation, oldTypes.reservation);
  });

  it('una política que ya los tiene no cambia', () => {
    const upgraded = upgradeStoredPolicy(DEFAULT_POLICY);
    assert.deepEqual(upgraded.types.file_change, DEFAULT_POLICY.types.file_change);
  });
});
