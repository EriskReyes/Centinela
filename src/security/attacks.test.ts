/**
 * Fase 7 — Pruebas de ataque: Centinela contra sí mismo.
 *
 * Cada test es un intento real de romper el sistema por la API pública.
 * Si la suite pasa, la defensa aguanta; si algo falla, hay un agujero.
 * El resultado completo y comentado está en docs/07-ataques.md.
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
import { challengeFingerprint } from '../auth/signing.ts';
import type { RelyingParty } from '../auth/webauthnService.ts';
import { InMemoryAuditRepository } from '../audit/repository.ts';
import { createAuditService } from '../audit/service.ts';
import { DEFAULT_POLICY } from '../rules/policy.ts';

const RP: RelyingParty = { rpName: 'Centinela', rpID: 'localhost', origin: 'http://localhost:4000' };

interface Harness {
  base: string;
  clock: { advance: (ms: number) => void };
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, any> }>;
  get: (path: string) => Promise<{ status: number; body: Record<string, any> }>;
  auditRepo: InMemoryAuditRepository;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const repository = new InMemoryActionRepository();
  const credentials = new InMemoryCredentialRepository();
  const challenges = new InMemoryChallengeRepository();
  const auditRepository = new InMemoryAuditRepository();
  let auditCounter = 0;
  const audit = createAuditService({ repository: auditRepository, idFactory: () => `audit-${++auditCounter}` });
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
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  try {
    await fn({ base, clock, post, get, auditRepo: auditRepository });
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

async function proposePending(post: Harness['post']): Promise<string> {
  const res = await post(
    '/api/actions',
    pay({ amountMinor: 500_00, justification: 'Renovación anual de licencias del equipo' }),
    { 'Idempotency-Key': `probe-${crypto.randomUUID()}` },
  );
  assert.equal(res.status, 202);
  return res.body.action.id as string;
}

describe('Fase 7 — entrada maliciosa', () => {
  it('tipo de acción inexistente → 400 en el borde', async () => {
    await withHarness(async (h) => {
      const res = await h.post('/api/actions', pay({ actionType: 'transfer' }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'validación');
    });
  });

  it('importe negativo o cero → 400', async () => {
    await withHarness(async (h) => {
      assert.equal((await h.post('/api/actions', pay({ amountMinor: -100 }))).status, 400);
      assert.equal((await h.post('/api/actions', pay({ amountMinor: 0 }))).status, 400);
      assert.equal((await h.post('/api/actions', pay({ amountMinor: 'mucho' }))).status, 400);
    });
  });

  it('importe descomunal → bloqueado por el motor, sin desbordar nada', async () => {
    await withHarness(async (h) => {
      const res = await h.post('/api/actions', pay({ amountMinor: 1e15 }));
      assert.equal(res.status, 403); // por encima del límite máximo
      assert.equal(res.body.decision, 'block');
    });
  });

  it('moneda que no es ISO 4217 → 400', async () => {
    await withHarness(async (h) => {
      const res = await h.post('/api/actions', pay({ currency: 'eur' }));
      assert.equal(res.status, 400);
    });
  });

  it('justificación vacía o mínima → 400', async () => {
    await withHarness(async (h) => {
      assert.equal((await h.post('/api/actions', pay({ justification: '' }))).status, 400);
      assert.equal((await h.post('/api/actions', pay({ justification: 'ok' }))).status, 400);
    });
  });

  it('payload gigante → 413 (límite de 100 kb)', async () => {
    await withHarness(async (h) => {
      const res = await fetch(`${h.base}/api/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pay({ justification: 'x'.repeat(150_000) })),
      });
      assert.equal(res.status, 413);
    });
  });

  it('prototype pollution vía metadata → inofensivo y sin contaminar Object.prototype', async () => {
    await withHarness(async (h) => {
      const res = await h.post('/api/actions', pay({
        metadata: { __proto__: { polluted: true }, nota: 'dato legítimo' },
      }));
      assert.equal(res.status, 201);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(res.body.action.metadata.nota, 'dato legítimo');
    });
  });

  it('inyección noSQL en filtros → el filtro no se interpreta como operador', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      const res = await h.get('/api/actions?status[$ne]=approved&limit=10');
      assert.equal(res.status, 200);
      assert.equal(res.body.actions.length, 1); // listado normal, sin inyección
    });
  });

  it('campos desconocidos → eliminados por el esquema, no guardados', async () => {
    await withHarness(async (h) => {
      const res = await h.post('/api/actions', pay({ esAdmin: true, status: 'approved' }));
      // El cliente no puede elegir el estado inicial: se ignora y se propone.
      assert.equal(res.status, 201);
      assert.equal(res.body.action.status, 'approved'); // decidido por el MOTOR, no por el cliente
      assert.equal('esAdmin' in res.body.action, false);
    });
  });
});

describe('Fase 7 — replay y duplicación', () => {
  it('misma Idempotency-Key dos veces → una sola acción', async () => {
    await withHarness(async (h) => {
      const first = await h.post('/api/actions', pay(), { 'Idempotency-Key': 'ataque-1' });
      const second = await h.post('/api/actions', pay(), { 'Idempotency-Key': 'ataque-1' });
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal(second.body.replayed, true);
      const all = await h.get('/api/actions?limit=10');
      assert.equal(all.body.actions.length, 1);
    });
  });

  it('doble envío PARALELO con la misma clave → una sola acción (índice único)', async () => {
    await withHarness(async (h) => {
      const [a, b] = await Promise.all([
        h.post('/api/actions', pay(), { 'Idempotency-Key': 'carrera-1' }),
        h.post('/api/actions', pay(), { 'Idempotency-Key': 'carrera-1' }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 201]);
      const all = await h.get('/api/actions?limit=10');
      assert.equal(all.body.actions.length, 1);
    });
  });

  it('firma reutilizada sobre una acción ya aprobada → 409', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const assertion = authenticator.assert(options.body.options);
      assert.equal((await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: assertion })).status, 200);
      assert.equal((await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: assertion })).status, 409);
    });
  });

  it('un intento fallido consume el reto: ni la firma buena posterior vale', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const good = authenticator.assert(options.body.options);
      const tampered = tamperAssertion(good);
      assert.equal((await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: tampered })).status, 400);
      assert.equal((await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: good })).status, 400);
    });
  });

  it('un reto pedido para una acción no vale para otra', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const a = await proposePending(h.post);
      const b = await proposePending(h.post);
      const options = await h.post(`/api/actions/${a}/sign/options`, { decision: 'approve' });
      const res = await h.post(`/api/actions/${b}/sign/verify`, { decision: 'approve', response: authenticator.assert(options.body.options) });
      assert.equal(res.status, 400);
    });
  });

  it('la misma propuesta SIN clave ya no se duplica (red de seguridad con ventana)', async () => {
    await withHarness(async (h) => {
      const first = await h.post('/api/actions', pay());
      const second = await h.post('/api/actions', pay());
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal(second.body.replayed, true);
      const all = await h.get('/api/actions?limit=10');
      assert.equal(all.body.actions.length, 1);

      // Un reintento TARDÍO (fuera de la ventana) sí crea otra acción: limitación documentada.
      h.clock.advance(61_000);
      const late = await h.post('/api/actions', pay());
      assert.equal(late.status, 201);
    });
  });
});

describe('Fase 7 — firmas falsificadas', () => {
  it('llave no registrada → 400', async () => {
    await withHarness(async (h) => {
      await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const intruder = new FakeAuthenticator(RP.rpID, RP.origin);
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: intruder.assert(options.body.options) });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.error).includes('no está registrada'));
    });
  });

  it('llave clonada que firma desde un origen malicioso → 400 (check de origen)', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const thief = authenticator.clone(RP.rpID, 'http://evil.example');
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: thief.assert(options.body.options) });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.error).includes('firma'));
    });
  });

  it('llave clonada con rpID malicioso → 400 (rpIdHash)', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const thief = authenticator.clone('evil.localhost', RP.origin);
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: thief.assert(options.body.options) });
      assert.equal(res.status, 400);
    });
  });

  it('firma manipulada → 400 y el fallo queda auditado', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const good = authenticator.assert(options.body.options);
      const tampered = tamperAssertion(good);
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: tampered });
      assert.equal(res.status, 400);
      const failure = h.auditRepo.entries.find((e) => e.eventType === 'signature_failed');
      assert.ok(failure);
      assert.equal(failure.actor, authenticator.id);
    });
  });

  it('firmar con decisión distinta a la del reto → 400', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'reject', response: authenticator.assert(options.body.options) });
      assert.equal(res.status, 400);
    });
  });

  it('una misma llave no puede cubrir las dos firmas del cuarto ojos (409)', async () => {
    await withHarness(async (h) => {
      const registerKeyFor = async (userId: string): Promise<FakeAuthenticator> => {
        const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
        const options = await h.post('/api/webauthn/register/options', { userId });
        const verified = await h.post('/api/webauthn/register/verify', {
          userId,
          role: 'autorizador',
          response: authenticator.register(options.body.options),
        });
        assert.equal(verified.status, 201);
        return authenticator;
      };
      const maria = await registerKeyFor('maria');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00, justification: 'Renovación anual de licencias del equipo' }))).body.action.id as string;

      const options1 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'maria' });
      await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', userId: 'maria', response: maria.assert(options1.body.options) });

      const options2 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'maria' });
      const again = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', userId: 'maria', response: maria.assert(options2.body.options) });
      assert.equal(again.status, 409);
      assert.ok(String(again.body.error).includes('persona distinta'));
    });
  });

  it('un empleado no puede firmar el quórum de autorizadores (403 por rol)', async () => {
    await withHarness(async (h) => {
      const registerKeyFor = async (userId: string, role: string): Promise<FakeAuthenticator> => {
        const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
        const options = await h.post('/api/webauthn/register/options', { userId });
        const verified = await h.post('/api/webauthn/register/verify', {
          userId,
          role,
          response: authenticator.register(options.body.options),
        });
        assert.equal(verified.status, 201);
        return authenticator;
      };
      const carlos = await registerKeyFor('carlos', 'empleado');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00, justification: 'Renovación anual de licencias del equipo' }))).body.action.id as string;

      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'carlos' });
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        userId: 'carlos',
        response: carlos.assert(options.body.options),
      });
      assert.equal(res.status, 403);
      assert.ok(String(res.body.error).includes('rol'));
    });
  });

  it('la pantalla no puede inventarse el código: la huella sale del reto real', async () => {
    await withHarness(async (h) => {
      await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      // Lo que el humano compara está ligado al reto criptográfico, no a la UI.
      assert.equal(options.body.fingerprint, challengeFingerprint(options.body.options.challenge));
      // Las dos decisiones tienen códigos distintos: un "sí" no se disfraza de "no".
      const fp = await h.get(`/api/actions/${actionId}/fingerprints`);
      assert.notEqual(fp.body.approve, fp.body.reject);
    });
  });
});

describe('Fase 7 — estados y política', () => {
  it('firmar una acción ya decidida → 409', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: authenticator.assert(options.body.options) });
      const again = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(again.status, 409);
    });
  });

  it('firmar una solicitud expirada → 409 y pasa a expired', async () => {
    await withHarness(async (h) => {
      await registerKey(h.post);
      const actionId = await proposePending(h.post);
      h.clock.advance(16 * 60_000);
      const res = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(res.status, 409);
    });
  });

  it('política con límites incoherentes → 400 y la vigente queda intacta', async () => {
    await withHarness(async (h) => {
      const current = (await h.get('/api/policy')).body.policy as { version: number };
      const res = await fetch(`${h.base}/api/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...DEFAULT_POLICY,
          types: { ...DEFAULT_POLICY.types, payment: { ...DEFAULT_POLICY.types.payment, allowLimitMinor: 100_00, signLimitMinor: 100_00 } },
        }),
      });
      assert.equal(res.status, 400);
      const after = (await h.get('/api/policy')).body.policy as { version: number };
      assert.equal(after.version, current.version);
    });
  });

  it('política sin un tipo obligatorio → 400', async () => {
    await withHarness(async (h) => {
      const { loan: _loan, ...types } = DEFAULT_POLICY.types;
      const res = await fetch(`${h.base}/api/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...DEFAULT_POLICY, types }),
      });
      assert.equal(res.status, 400);
    });
  });

  it('intento de regresión de versión → el servidor asigna la siguiente', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay()); // arranca la política v1
      const res = await fetch(`${h.base}/api/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...DEFAULT_POLICY, version: 1 }), // el cliente finge que sigue en v1
      });
      assert.equal(res.status, 200);
      const saved = ((await res.json()) as { policy: { version: number } }).policy;
      assert.equal(saved.version, 2); // nunca se sobrescribe la existente
    });
  });

  it('las restricciones de la política se hacen cumplir: loan, crypto y GBP', async () => {
    await withHarness(async (h) => {
      assert.equal((await h.post('/api/actions', pay({ actionType: 'loan' }))).status, 403);
      assert.equal((await h.post('/api/actions', pay({ destination: 'crypto:binance' }))).status, 403);
      assert.equal((await h.post('/api/actions', pay({ currency: 'GBP' }))).status, 403);
    });
  });
});

describe('Fase 7 — integridad del registro', () => {
  it('manipular un campo del registro → la cadena se rompe y se localiza', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      h.auditRepo.entries[1]!.reason = 'el atacante reescribió la historia';
      const verify = await h.get('/api/audit/verify');
      assert.equal(verify.body.ok, false);
      assert.equal(verify.body.firstBreak, 2);
    });
  });

  it('manipular un hash → la cadena se rompe en esa entrada', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      h.auditRepo.entries[0]!.contentHash = 'a'.repeat(43);
      const verify = await h.get('/api/audit/verify');
      assert.equal(verify.body.ok, false);
      assert.equal(verify.body.firstBreak, 1);
    });
  });

  it('borrar una entrada → hueco en la secuencia detectado', async () => {
    await withHarness(async (h) => {
      await h.post('/api/actions', pay());
      await h.post('/api/actions', pay({ destination: 'crypto:binance' }));
      h.auditRepo.entries.splice(1, 1);
      const verify = await h.get('/api/audit/verify');
      assert.equal(verify.body.ok, false);
    });
  });
});
