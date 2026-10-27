import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { entryContentHash, GENESIS_HASH, linkHash, type AuditEntry } from './events.ts';

const base: Omit<AuditEntry, 'contentHash'> = {
  id: 'a-1',
  seq: 1,
  eventType: 'engine_decision',
  actionId: 'act-1',
  actor: 'rules-engine',
  decision: 'sign',
  statusBefore: 'proposed',
  statusAfter: 'pending_signature',
  reason: 'importe alto',
  policyVersion: 1,
  at: new Date('2026-10-26T10:00:00Z'),
  prevHash: GENESIS_HASH,
};

describe('hashing del registro de auditoría', () => {
  it('es determinista para el mismo contenido', () => {
    assert.equal(entryContentHash(base), entryContentHash({ ...base }));
    assert.equal(entryContentHash(base).length, 43);
  });

  it('cambia si cambia cualquier campo del contenido', () => {
    const original = entryContentHash(base);
    assert.notEqual(original, entryContentHash({ ...base, reason: 'otro motivo' }));
    assert.notEqual(original, entryContentHash({ ...base, decision: 'block' }));
    assert.notEqual(original, entryContentHash({ ...base, seq: 2 }));
    assert.notEqual(original, entryContentHash({ ...base, actionId: 'act-2' }));
    assert.notEqual(original, entryContentHash({ ...base, actor: 'otro-actor' }));
    assert.notEqual(original, entryContentHash({ ...base, policyVersion: 2 }));
    assert.notEqual(original, entryContentHash({ ...base, at: new Date('2026-10-26T10:00:01Z') }));
  });

  it('el eslabón depende del eslabón anterior', () => {
    const a = linkHash('contenido-a', 'eslabon-1');
    assert.equal(a, linkHash('contenido-a', 'eslabon-1'));
    assert.notEqual(a, linkHash('contenido-a', 'eslabon-2'));
    assert.notEqual(a, linkHash('contenido-b', 'eslabon-1'));
  });

  it('el hash génesis es constante', () => {
    assert.equal(GENESIS_HASH.length, 43);
  });
});
