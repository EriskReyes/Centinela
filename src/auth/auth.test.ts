/**
 * Fase 4 — Pruebas del flujo completo de firma con un AUTENTICADOR VIRTUAL
 * que firma de verdad (EC P-256). Criptografía real, sin navegador.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../api/app.ts';
import { InMemoryActionRepository } from '../api/repository.ts';
import { InMemoryPolicyProvider } from '../api/policyProvider.ts';
import {
  InMemoryChallengeRepository,
  InMemoryCredentialRepository,
} from './repos.ts';
import { createWebAuthnService, type RelyingParty } from './webauthnService.ts';
import { AuthError } from './errors.ts';
import { AgentActionSchema } from '../domain/action.ts';
import { FakeAuthenticator, tamperAssertion } from './testkit.ts';
import { challengeFingerprint, challengeForAction } from './signing.ts';
import { DEFAULT_POLICY } from '../rules/policy.ts';
import { TEST_ACCESS, authedFetch } from '../api/testAccess.ts';

const RP: RelyingParty = { rpName: 'Centinela', rpID: 'localhost', origin: 'http://localhost:4000' };

interface Harness {
  base: string;
  clock: { advance: (ms: number) => void };
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, any> }>;
  get: (path: string) => Promise<{ status: number; body: Record<string, any> }>;
  close: () => Promise<void>;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const repository = new InMemoryActionRepository();
  const credentials = new InMemoryCredentialRepository();
  const challenges = new InMemoryChallengeRepository();
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
    access: TEST_ACCESS,
    repository,
    policyProvider: new InMemoryPolicyProvider(DEFAULT_POLICY),
    now: clock.now,
    idFactory,
    auth: { repository, credentials, challenges, rp: RP, now: clock.now, idFactory },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await authedFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const get = async (path: string) => {
    const res = await authedFetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    await fn({ base, clock, post, get, close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const pay = (over: Record<string, unknown> = {}) => ({
  agentId: 'agente-compras',
  actionType: 'payment',
  amountMinor: 500_00,
  currency: 'EUR',
  destination: 'amazon.es',
  justification: 'Renovación anual de licencias del equipo',
  ...over,
});

/** Propone un pago que exige firma y devuelve el id de la acción. */
async function proposePending(post: Harness['post']): Promise<string> {
  const res = await post('/api/actions', pay(), { 'Idempotency-Key': `probe-${randomUUID()}` });
  assert.equal(res.status, 202);
  return res.body.action.id as string;
}

/** Registra una llave virtual y la devuelve lista para firmar. */
async function registerKey(post: Harness['post']): Promise<FakeAuthenticator> {
  const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
  const options = await post('/api/webauthn/register/options', {});
  assert.equal(options.status, 200);
  const verified = await post('/api/webauthn/register/verify', {
    role: 'autorizador',
    response: authenticator.register(options.body.options),
  });
  assert.equal(verified.status, 201);
  return authenticator;
}

describe('registro de llaves', () => {
  it('registra una llave y queda guardada', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const list = await h.get('/api/webauthn/credentials');
      assert.equal(list.status, 200);
      assert.equal(list.body.credentials.length, 1);
      assert.equal(list.body.credentials[0].id, authenticator.id);
      assert.equal(list.body.credentials[0].counter, 0);
    });
  });

  it('rechaza verificar un registro sin reto previo', async () => {
    await withHarness(async (h) => {
      const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
      // Fabricamos una respuesta sin haber pedido opciones: no hay reto que consumir.
      const forged = authenticator.register({
        rp: { id: RP.rpID, name: RP.rpName },
        user: { id: 'bWFyaWE', name: 'maria', displayName: 'María' },
        challenge: 'a'.repeat(43),
        pubKeyCredParams: [],
      });
      const res = await h.post('/api/webauthn/register/verify', { response: forged });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.error).includes('registro en curso'));
    });
  });
});

describe('firma de acciones', () => {
  it('el flujo completo aprueba la acción y registra qué llave firmó', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);

      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(options.status, 200);
      assert.equal(options.body.action.id, actionId);

      const signed = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(signed.status, 200);
      assert.equal(signed.body.action.status, 'approved');
      const signature = signed.body.action.decisions[1];
      assert.equal(signature.stage, 'signature');
      assert.equal(signature.decision, 'approved');
      assert.equal(signature.by, authenticator.id);
    });
  });

  it('puede rechazar con la misma llave', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'reject' });
      const signed = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'reject',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(signed.status, 200);
      assert.equal(signed.body.action.status, 'rejected');
      assert.equal(signed.body.action.decisions[1].decision, 'rejected');
    });
  });

  it('una firma ya aplicada no se puede reutilizar sobre la acción decidida', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const signed = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(signed.status, 200);

      // La acción ya está aprobada: el replay se frena en la máquina de estados.
      const replay = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(replay.status, 409);
      assert.ok(String(replay.body.error).includes('no está pendiente'));
    });
  });

  it('un intento de firma fallido consume el reto (ni la firma buena del mismo reto vale)', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });

      // Una firma manipulada: rompemos su primer carácter (siempre significativo).
      const good = authenticator.assert(options.body.options);
      const tampered = tamperAssertion(good);
      const first = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: tampered });
      assert.equal(first.status, 400);
      assert.ok(String(first.body.error).includes('firma'));

      // El reto ya se consumió con el intento fallido: ni la firma BUENA vale.
      const second = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: good });
      assert.equal(second.status, 400);
      assert.ok(String(second.body.error).includes('reutilizando una firma'));

      // Y nadie aprobó nada: la acción sigue pendiente.
      const action = (await (await authedFetch(`${h.base}/api/actions/${actionId}`)).json()) as {
        action: { status: string };
      };
      assert.equal(action.action.status, 'pending_signature');
    });
  });

  it('firmar con una decisión distinta a la pedida en el reto falla', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      // Reto pedido para 'approve'…
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      // …pero el cliente dice 'reject': no hay reto de 'reject' guardado.
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'reject',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(res.status, 400);
    });
  });

  it('un reto pedido para una acción no vale para otra', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const first = await proposePending(h.post);
      const second = await proposePending(h.post);

      const options = await h.post(`/api/actions/${first}/sign/options`, { decision: 'approve' });
      const res = await h.post(`/api/actions/${second}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.error).includes('reutilizando una firma'));
    });
  });

  it('firmar con una llave no registrada falla', async () => {
    await withHarness(async (h) => {
      await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });

      const intruder = new FakeAuthenticator(RP.rpID, RP.origin);
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: intruder.assert(options.body.options),
      });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.error).includes('no está registrada'));
    });
  });

  it('una acción expirada no se puede firmar y pasa a expired', async () => {
    await withHarness(async (h) => {
      await registerKey(h.post);
      const actionId = await proposePending(h.post);
      h.clock.advance(16 * 60_000);
      const res = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(res.status, 409);
      assert.ok(String(res.body.error).includes('expiró'));
      const after = (await (await authedFetch(`${h.base}/api/actions/${actionId}`)).json()) as {
        action: { status: string };
      };
      assert.equal(after.action.status, 'expired');
    });
  });

  it('una acción ya decidida no se puede volver a firmar', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: authenticator.assert(options.body.options) });

      const again = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(again.status, 409);
      assert.ok(String(again.body.error).includes('no está pendiente'));
    });
  });

  it('sin llaves registradas no se pueden pedir opciones de firma', async () => {
    await withHarness(async (h) => {
      const actionId = await proposePending(h.post);
      const res = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.error).includes('no tiene llaves'));
    });
  });

  it('el contador anti-replay avanza con cada firma', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);

      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });

      const list = await h.get('/api/webauthn/credentials');
      assert.equal(list.body.credentials[0].counter, 1);
    });
  });
});

describe('verificación entre canales (huella del reto)', () => {
  it('sign/options devuelve la huella del reto real que se va a firmar', async () => {
    await withHarness(async (h) => {
      await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(options.status, 200);
      assert.equal(options.body.fingerprint, challengeFingerprint(options.body.options.challenge));
      assert.equal(options.body.fingerprint.length, 19); // XXXX-XXXX-XXXX-XXXX
    });
  });

  it('GET /api/actions/:id/fingerprints da los códigos de ambas decisiones sin crear retos', async () => {
    await withHarness(async (h) => {
      await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const fp = await h.get(`/api/actions/${actionId}/fingerprints`);
      assert.equal(fp.status, 200);

      const action = (await h.get(`/api/actions/${actionId}`)).body.action as Record<string, any>;
      assert.equal(fp.body.approve, challengeFingerprint(challengeForAction(action as never, 'approve')));
      assert.equal(fp.body.reject, challengeFingerprint(challengeForAction(action as never, 'reject')));
      assert.notEqual(fp.body.approve, fp.body.reject);

      // Leer códigos NO guarda retos: firmar sin haber pedido opciones sigue fallando.
      const verify = await h.post(`/api/actions/${actionId}/sign/verify`, { decision: 'approve', response: {} });
      assert.equal(verify.status, 400);
    });
  });

  it('los códigos solo existen para acciones pendientes de firma', async () => {
    await withHarness(async (h) => {
      const created = await h.post('/api/actions', {
        agentId: 'agente-compras',
        actionType: 'payment',
        amountMinor: 25_00,
        currency: 'EUR',
        destination: 'amazon.es',
        justification: 'Compra de material de oficina aprobada en presupuesto mensual',
      });
      assert.equal(created.status, 201); // aprobada: no está pendiente
      const fp = await h.get(`/api/actions/${created.body.action.id}/fingerprints`);
      assert.equal(fp.status, 409);
    });
  });
});

describe('cuarto ojos: dos firmas de personas distintas', () => {
  async function registerKeyFor(
    post: Harness['post'],
    userId: string,
    role = 'autorizador',
  ): Promise<FakeAuthenticator> {
    const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
    const options = await post('/api/webauthn/register/options', { userId });
    const verified = await post('/api/webauthn/register/verify', {
      userId,
      role,
      response: authenticator.register(options.body.options),
    });
    assert.equal(verified.status, 201);
    return authenticator;
  }

  it('700,00 € exigen dos firmas y la acción solo se aprueba con la segunda persona', async () => {
    await withHarness(async (h) => {
      const maria = await registerKeyFor(h.post, 'maria');
      const carlos = await registerKeyFor(h.post, 'carlos');
      const proposed = await h.post('/api/actions', pay({ amountMinor: 700_00 }));
      assert.equal(proposed.status, 202);
      assert.equal(proposed.body.action.requiredSignatures, 2);
      const actionId = proposed.body.action.id as string;

      // Primera firma: María → sigue pendiente con 1 de 2.
      const options1 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'maria' });
      const first = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        userId: 'maria',
        response: maria.assert(options1.body.options),
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.action.status, 'pending_signature');
      assert.equal(first.body.action.signatures.length, 1);

      // La huella del segundo reto cambia: queda ligada al progreso.
      const options2 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'carlos' });
      assert.notEqual(options1.body.fingerprint, options2.body.fingerprint);

      // Segunda firma: Carlos → aprobada.
      const second = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        userId: 'carlos',
        response: carlos.assert(options2.body.options),
      });
      assert.equal(second.status, 200);
      assert.equal(second.body.action.status, 'approved');
      assert.equal(second.body.action.signatures.length, 2);
    });
  });

  it('la misma llave no puede cubrir las dos firmas', async () => {
    await withHarness(async (h) => {
      const maria = await registerKeyFor(h.post, 'maria');
      await registerKeyFor(h.post, 'carlos');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00 }))).body.action.id as string;

      const options1 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'maria' });
      await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        userId: 'maria',
        response: maria.assert(options1.body.options),
      });

      const options2 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'maria' });
      const again = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        userId: 'maria',
        response: maria.assert(options2.body.options),
      });
      assert.equal(again.status, 409);
      assert.ok(String(again.body.error).includes('persona distinta'));
    });
  });

  it('no se puede firmar en nombre de otra persona', async () => {
    await withHarness(async (h) => {
      const maria = await registerKeyFor(h.post, 'maria');
      const carlos = await registerKeyFor(h.post, 'carlos');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00 }))).body.action.id as string;
      // El cliente reclama ser Carlos (y pide opciones para las llaves de Carlos)…
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'carlos' });
      assert.equal(options.status, 200);
      // …pero presenta la llave de MARÍA: el servidor detecta la suplantación.
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        userId: 'carlos',
        response: maria.assert(options.body.options),
      });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.error).includes("'maria'"));
      // Carlos sigue sin haber firmado nada.
      const action = (await h.get(`/api/actions/${actionId}`)).body.action as Record<string, any>;
      assert.equal(action.signatures.length, 0);
    });
  });

  it('un rechazo es veto aunque el quórum pida dos firmas', async () => {
    await withHarness(async (h) => {
      const maria = await registerKeyFor(h.post, 'maria');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00 }))).body.action.id as string;
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'reject', userId: 'maria' });
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'reject',
        userId: 'maria',
        response: maria.assert(options.body.options),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.action.status, 'rejected');
    });
  });
});

describe('roles en el cuarto ojos', () => {
  async function registerKeyFor(post: Harness['post'], userId: string, role: string): Promise<FakeAuthenticator> {
    const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
    const options = await post('/api/webauthn/register/options', { userId });
    const verified = await post('/api/webauthn/register/verify', {
      userId,
      role,
      response: authenticator.register(options.body.options),
    });
    assert.equal(verified.status, 201);
    return authenticator;
  }

  it('un empleado no puede firmar una acción de autorizadores (403)', async () => {
    await withHarness(async (h) => {
      const maria = await registerKeyFor(h.post, 'maria', 'autorizador');
      const carlos = await registerKeyFor(h.post, 'carlos', 'empleado');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00 }))).body.action.id as string;

      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'carlos' });
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        userId: 'carlos',
        response: carlos.assert(options.body.options),
      });
      assert.equal(res.status, 403);
      assert.ok(String(res.body.error).includes('rol'));

      // La firma rechazada no dejó rastro de progreso.
      const action = (await h.get(`/api/actions/${actionId}`)).body.action as Record<string, any>;
      assert.equal(action.signatures.length, 0);
      void maria;
    });
  });

  it('dos autorizadores distintos completan el quórum', async () => {
    await withHarness(async (h) => {
      const maria = await registerKeyFor(h.post, 'maria', 'autorizador');
      const ana = await registerKeyFor(h.post, 'ana', 'autorizador');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00 }))).body.action.id as string;

      const options1 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'maria' });
      const first = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve', userId: 'maria', response: maria.assert(options1.body.options),
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.action.status, 'pending_signature');

      const options2 = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve', userId: 'ana' });
      const second = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve', userId: 'ana', response: ana.assert(options2.body.options),
      });
      assert.equal(second.status, 200);
      assert.equal(second.body.action.status, 'approved');
    });
  });

  it('el veto de un empleado tampoco vale (403)', async () => {
    await withHarness(async (h) => {
      await registerKeyFor(h.post, 'maria', 'autorizador');
      const carlos = await registerKeyFor(h.post, 'carlos', 'empleado');
      const actionId = (await h.post('/api/actions', pay({ amountMinor: 700_00 }))).body.action.id as string;

      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'reject', userId: 'carlos' });
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'reject',
        userId: 'carlos',
        response: carlos.assert(options.body.options),
      });
      assert.equal(res.status, 403);
      assert.ok(String(res.body.error).includes('rol'));
    });
  });
});

describe('revocación de llaves (llave perdida)', () => {
  it('una llave revocada deja de poder firmar al instante', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);

      const list = await h.get('/api/webauthn/credentials');
      assert.equal(list.body.credentials.length, 1);
      const credentialId = list.body.credentials[0].id as string;

      const revoked = await authedFetch(`${h.base}/api/webauthn/credentials/${encodeURIComponent(credentialId)}`, {
        method: 'DELETE',
      });
      assert.equal(revoked.status, 200);

      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(options.status, 200);
      const res = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(res.status, 403);
      assert.ok(String(res.body.error).includes('revocada'));
    });
  });

  it('revocar una llave inexistente devuelve 404', async () => {
    await withHarness(async (h) => {
      const res = await authedFetch(`${h.base}/api/webauthn/credentials/no-existe`, { method: 'DELETE' });
      assert.equal(res.status, 404);
    });
  });
});

describe('lo firmado se ejecuta', () => {
  it('al aprobar con la llave, el conector corre y queda registrado', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      const signed = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(signed.status, 200);
      assert.equal(signed.body.execution.ok, true);
      const stages = (signed.body.action.decisions as Array<{ stage: string }>).map((d) => d.stage);
      assert.deepEqual(stages, ['engine', 'signature', 'execution']);

      const stored = await h.get(`/api/actions/${actionId}`);
      assert.equal(stored.body.action.decisions.at(-1).stage, 'execution');
    });
  });

  it('un rechazo no ejecuta nada', async () => {
    await withHarness(async (h) => {
      const authenticator = await registerKey(h.post);
      const actionId = await proposePending(h.post);
      const options = await h.post(`/api/actions/${actionId}/sign/options`, { decision: 'reject' });
      const signed = await h.post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'reject',
        response: authenticator.assert(options.body.options),
      });
      assert.equal(signed.status, 200);
      assert.equal(signed.body.execution, undefined);
      assert.ok(!(signed.body.action.decisions as Array<{ stage: string }>).some((d) => d.stage === 'execution'));
    });
  });
});

describe('reto ligado al estado de la acción', () => {
  it('una firma sobre un reto viejo no vale si la acción cambió en medio (409)', async () => {
    const credentials = new InMemoryCredentialRepository();
    const service = createWebAuthnService({ rp: RP, credentials, challenges: new InMemoryChallengeRepository() });
    const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
    const reg = await service.registrationOptions('maria', 'María');
    await service.verifyRegistration('maria', 'autorizador', authenticator.register(reg));

    const action = AgentActionSchema.parse({
      id: randomUUID(),
      ...pay({ amountMinor: 700_00 }),
      status: 'pending_signature',
      createdAt: new Date(),
      decisions: [],
    });
    const options = await service.signOptions(action, 'approve', 'maria');
    // Otra persona firmó entre el reto y la respuesta.
    const changed = { ...action, signatures: [{ keyId: 'otra', userId: 'carlos', role: 'autorizador', at: new Date() }] };
    await assert.rejects(
      service.verifySignature(changed, 'approve', 'maria', authenticator.assert(options)),
      (err: AuthError) => err.status === 409,
    );
  });
});
