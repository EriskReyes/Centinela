/**
 * Fase 5 — Pruebas del registro de auditoría: todo queda registrado, la
 * cadena verifica y cualquier manipulación se detecta.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../api/app.ts';
import { InMemoryActionRepository } from '../api/repository.ts';
import { InMemoryPolicyProvider } from '../api/policyProvider.ts';
import { InMemoryChallengeRepository, InMemoryCredentialRepository } from '../auth/repos.ts';
import { FakeAuthenticator, tamperAssertion } from '../auth/testkit.ts';
import type { RelyingParty } from '../auth/webauthnService.ts';
import { InMemoryAuditRepository } from './repository.ts';
import { createAuditService } from './service.ts';
import { DEFAULT_POLICY } from '../rules/policy.ts';

const RP: RelyingParty = { rpName: 'Centinela', rpID: 'localhost', origin: 'http://localhost:4000' };

interface Harness {
  base: string;
  clock: { advance: (ms: number) => void };
  post: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, any> }>;
  get: (path: string) => Promise<{ status: number; body: Record<string, any> }>;
  auditRepo: InMemoryAuditRepository;
  close: () => Promise<void>;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const repository = new InMemoryActionRepository();
  const credentials = new InMemoryCredentialRepository();
  const challenges = new InMemoryChallengeRepository();
  const auditRepository = new InMemoryAuditRepository();
  let auditCounter = 0;
  const audit = createAuditService({
    repository: auditRepository,
    idFactory: () => `audit-${++auditCounter}`,
  });
  let counter = 0;
  const idFactory = () => `id-${++counter}`;
  let t = new Date('2026-10-26T10:00:00Z');
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t = new Date(t.getTime() + ms);
    },
  };
  const app: Express = createApp({
    repository,
    policyProvider: new InMemoryPolicyProvider(DEFAULT_POLICY),
    now: clock.now,
    idFactory,
    audit,
    auth: { repository, credentials, challenges, rp: RP, now: clock.now, idFactory, audit },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    await fn({ base, clock, post, get, auditRepo: auditRepository, close: () => Promise.resolve() });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const pay = (over: Record<string, unknown> = {}) => ({
  agentId: 'agente-compras',
  actionType: 'payment',
  amountMinor: 25_00,
  currency: 'EUR',
  destination: 'amazon.es',
  justification: 'Compra de material de oficina aprobada en presupuesto mensual',
  ...over,
});

async function registerKey(post: Harness['post']): Promise<FakeAuthenticator> {
  const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
  const options = await post('/api/webauthn/register/options', {});
  const verified = await post('/api/webauthn/register/verify', {
    role: 'autorizador',
    response: authenticator.register(options.body.options),
  });
  assert.equal(verified.status, 201);
  return authenticator;
}

describe('el registro captura todo', () => {
  it('flujo allow: propuesta + decisión del motor + ejecución', async () => {
    await withHarness(async (h) => {
      const res = await h.post('/api/actions', pay());
      assert.equal(res.status, 201);
      const entries = h.auditRepo.entries;
      assert.equal(entries.length, 3);
      assert.deepEqual(entries.map((e) => e.eventType), ['action_proposed', 'engine_decision', 'action_executed']);
      assert.equal(entries[0]?.actor, 'agente-compras');
      assert.equal(entries[1]?.actor, 'rules-engine');
      assert.equal(entries[1]?.decision, 'allow');
      assert.equal(entries[1]?.policyVersion, 1);
      assert.equal(entries[2]?.actor, 'simulador-pagos');
      assert.equal(entries[2]?.decision, 'approved');
    });
  });

  it('los bloqueos también quedan registrados, con su motivo', async () => {
    await withHarness(async (h) => {
      const res = await h.post('/api/actions', pay({ destination: 'crypto:binance' }));
      assert.equal(res.status, 403);
      const entries = h.auditRepo.entries;
      assert.equal(entries.length, 2);
      assert.equal(entries[1]?.eventType, 'engine_decision');
      assert.equal(entries[1]?.decision, 'block');
      assert.ok(entries[1]?.reason?.includes('prohibido'));
    });
  });

  it('flujo de firma: petición y firma verificada, con la llave como actor', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const proposed = await h.post('/api/actions', pay({ amountMinor: 500_00 }));
      const actionId = proposed.body.action.id as string;
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const signed = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(signed.status, 200);

      const entries = h.auditRepo.entries;
      assert.deepEqual(entries.map((e) => e.eventType), [
        'action_proposed',
        'engine_decision',
        'signature_requested',
        'action_signed',
      ]);
      const signature = entries[3];
      assert.equal(signature?.actor, authenticator.id);
      assert.equal(signature?.decision, 'approved');
    });
  });

  it('los fallos de firma quedan registrados con el motivo', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const proposed = await h.post('/api/actions', pay({ amountMinor: 500_00 }));
      const actionId = proposed.body.action.id as string;
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });

      const good = authenticator.assert(options.body.options);
      const tampered = tamperAssertion(good);
      const failed = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: tampered });
      assert.equal(failed.status, 400);

      const types = h.auditRepo.entries.map((e) => e.eventType);
      assert.ok(types.includes('signature_failed'));
      const failure = h.auditRepo.entries.find((e) => e.eventType === 'signature_failed');
      assert.equal(failure?.actor, authenticator.id);
      assert.ok(failure?.reason?.includes('firma'));
    });
  });

  it('las expiraciones quedan registradas', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay({ amountMinor: 500_00 }));
      h.clock.advance(16 * 60_000);
      const pending = await h.get('/api/actions/pending');
      assert.equal(pending.body.actions.length, 0);
      const expiry = h.auditRepo.entries.find((e) => e.eventType === 'action_expired');
      assert.ok(expiry);
      assert.equal(expiry.actor, 'system');
      assert.equal(expiry.statusAfter, 'expired');
    });
  });

  it('los cambios de política también quedan auditados', async () => {
    await withHarness(async (h) => {
      const current = (await (await fetch(`${h.base}/api/policy`)).json()) as {
        policy: { id: string; version: number; types: { payment: { allowLimitMinor: number } } };
      };
      const updated = {
        ...current.policy,
        types: {
          ...current.policy.types,
          payment: { ...current.policy.types.payment, allowLimitMinor: 900_00 },
        },
      };
      const res = await fetch(`${h.base}/api/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      });
      assert.equal(res.status, 200);
      const entry = h.auditRepo.entries.find((e) => e.eventType === 'policy_updated');
      assert.ok(entry);
      assert.equal(entry.actor, 'admin-panel');
      assert.equal(entry.policyVersion, 2);
      assert.ok(entry.reason?.includes('versión 2'));
    });
  });
});

describe('integridad de la cadena', () => {
  it('verifica íntegra tras los flujos normales', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      await h.post('/api/actions', pay({ destination: 'crypto:binance' }));
      const verify = await h.get('/api/audit/verify');
      assert.equal(verify.status, 200);
      assert.equal(verify.body.ok, true);
      assert.equal(verify.body.total, 5); // 3 (allow) + 2 (block)
    });
  });

  it('detecta la manipulación de un campo del registro', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      await h.post('/api/actions', pay({ destination: 'crypto:binance' }));
      // Un atacante altera el motivo de la entrada 2.
      h.auditRepo.entries[1]!.reason = 'manipulado';
      const verify = await h.get('/api/audit/verify');
      assert.equal(verify.body.ok, false);
      assert.equal(verify.body.firstBreak, 2);
    });
  });

  it('detecta la manipulación de un hash del registro', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      h.auditRepo.entries[0]!.contentHash = 'a'.repeat(43);
      const verify = await h.get('/api/audit/verify');
      assert.equal(verify.body.ok, false);
      assert.equal(verify.body.firstBreak, 1);
    });
  });

  it('detecta huecos en la secuencia', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      // Un atacante borra la entrada 2 y renumera... en realidad la borra sin más.
      h.auditRepo.entries.splice(1, 1);
      const verify = await h.get('/api/audit/verify');
      assert.equal(verify.body.ok, false);
    });
  });
});

describe('consultas', () => {
  it('lista con filtros por tipo de evento', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      await h.post('/api/actions', pay({ amountMinor: 500_00 }));
      const res = await h.get('/api/audit?eventType=engine_decision');
      assert.equal(res.status, 200);
      assert.equal(res.body.entries.length, 2);
      assert.ok(res.body.entries.every((e: { eventType: string }) => e.eventType === 'engine_decision'));
    });
  });

  it('línea temporal de una acción: registro + rastro embebido', async () => {
    await withHarness(async (h) => {
      const created = await h.post('/api/actions', pay());
      const actionId = created.body.action.id as string;
      const res = await h.get(`/api/audit/${actionId}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.action.id, actionId);
      assert.equal(res.body.entries.length, 3);
      // El rastro embebido (2 decisiones) vive dentro de la acción.
      assert.equal(res.body.action.decisions.length, 2);
    });
  });

  it('rechaza tipos de evento desconocidos', async () => {
    await withHarness(async (h) => {
      const res = await h.get('/api/audit?eventType=trucado');
      assert.equal(res.status, 400);
    });
  });

  it('devuelve 404 para acciones sin rastro', async () => {
    await withHarness(async (h) => {
      const res = await h.get('/api/audit/no-existe');
      assert.equal(res.status, 404);
    });
  });
});
