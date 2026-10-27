import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentActionSchema } from '../domain/action.ts';
import { buildSigningPayload, challengeFingerprint, challengeForAction } from './signing.ts';

const action = AgentActionSchema.parse({
  id: randomUUID(),
  agentId: 'agente-compras',
  actionType: 'payment',
  amountMinor: 500_00,
  currency: 'EUR',
  destination: 'amazon.es',
  justification: 'Renovación anual de licencias del equipo',
  status: 'pending_signature',
  createdAt: new Date('2026-10-26T10:00:00Z'),
  expiresAt: new Date('2026-10-26T10:15:00Z'),
  decisions: [],
});

describe('el reto de firma', () => {
  it('es el hash de los datos exactos: determinista y compacto', () => {
    const a = challengeForAction(action, 'approve');
    const b = challengeForAction(action, 'approve');
    assert.equal(a, b);
    assert.equal(a.length, 43); // SHA-256 en base64url sin padding
  });

  it('incluye todos los campos críticos de la acción, la decisión y el progreso de firmas', () => {
    const payload = JSON.parse(buildSigningPayload(action, 'approve'));
    assert.deepEqual(Object.keys(payload), [
      'actionId',
      'actionType',
      'amountMinor',
      'currency',
      'destination',
      'justification',
      'decision',
      'priorSignatures',
    ]);
  });

  it('cambia si cambia la decisión', () => {
    assert.notEqual(challengeForAction(action, 'approve'), challengeForAction(action, 'reject'));
  });

  it('cambia si cambia CUALQUIER dato de la acción (firmar otra cosa es imposible)', () => {
    const original = challengeForAction(action, 'approve');
    assert.notEqual(original, challengeForAction({ ...action, amountMinor: 500_01 }, 'approve'));
    assert.notEqual(original, challengeForAction({ ...action, amountMinor: 100_00 }, 'approve'));
    assert.notEqual(original, challengeForAction({ ...action, destination: 'otro-destino.es' }, 'approve'));
    assert.notEqual(original, challengeForAction({ ...action, justification: 'justificación distinta' }, 'approve'));
    assert.notEqual(original, challengeForAction({ ...action, currency: 'USD' }, 'approve'));
    assert.notEqual(original, challengeForAction({ ...action, id: randomUUID() }, 'approve'));
  });
});

describe('la huella de verificación entre canales', () => {
  it('es determinista, de 16 hex (64 bits) en 4 bloques legibles', () => {
    const challenge = challengeForAction(action, 'approve');
    const fingerprint = challengeFingerprint(challenge);
    assert.equal(fingerprint, challengeFingerprint(challenge));
    assert.equal(fingerprint.length, 19); // XXXX-XXXX-XXXX-XXXX
    assert.equal(fingerprint[4], '-');
    assert.equal(fingerprint[9], '-');
    assert.equal(fingerprint[14], '-');
    assert.match(fingerprint.replaceAll('-', ''), /^[0-9a-f]{16}$/);
  });

  it('cambia si cambia la decisión o cualquier dato', () => {
    assert.notEqual(
      challengeFingerprint(challengeForAction(action, 'approve')),
      challengeFingerprint(challengeForAction(action, 'reject')),
    );
    assert.notEqual(
      challengeFingerprint(challengeForAction(action, 'approve')),
      challengeFingerprint(challengeForAction({ ...action, amountMinor: 500_01 }, 'approve')),
    );
    assert.notEqual(
      challengeFingerprint(challengeForAction(action, 'approve')),
      challengeFingerprint(challengeForAction({ ...action, destination: 'otro.es' }, 'approve')),
    );
  });

  it('cuarto ojos: el reto cambia cuando cambia el progreso de firmas', () => {
    const original = challengeForAction(action, 'approve');
    const afterFirst = challengeForAction(
      {
        ...action,
        signatures: [{ keyId: 'llave-maria', userId: 'maria', role: 'autorizador', at: new Date('2026-10-26T10:05:00Z') }],
      },
      'approve',
    );
    assert.notEqual(original, afterFirst);
    assert.notEqual(
      challengeFingerprint(original),
      challengeFingerprint(afterFirst),
    );
  });
});
