/**
 * Pruebas de la API con repositorio en memoria: ejercitan TODO el flujo del
 * guardián (validación → motor → persistencia → respuesta) sin MongoDB,
 * usando un servidor HTTP real en el mismo proceso.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { AgentAction } from '../domain/action.ts';
import { createApp } from './app.ts';
import { InMemoryActionRepository, type ActionRepository } from './repository.ts';
import { InMemoryPolicyProvider } from './policyProvider.ts';
import { DEFAULT_POLICY, type Policy } from '../rules/policy.ts';
import { TEST_ACCESS, authedFetch } from './testAccess.ts';
interface Harness {
  base: string;
  repo: ActionRepository;
  clock: { now: () => Date; advance: (ms: number) => void };
  post: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
  get: (path: string) => Promise<Response>;
}

async function withHarness(fn: (h: Harness) => Promise<void>, policy: Policy = DEFAULT_POLICY): Promise<void> {
  let t = new Date('2026-10-26T10:00:00Z');
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t = new Date(t.getTime() + ms);
    },
  };
  let counter = 0;
  const repo = new InMemoryActionRepository();
  const app: Express = createApp({
    access: TEST_ACCESS,
    repository: repo,
    policyProvider: new InMemoryPolicyProvider(policy),
    now: clock.now,
    idFactory: () => `id-${++counter}`,
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({
      base,
      repo,
      clock,
      post: (body, headers = {}) =>
        authedFetch(`${base}/api/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      get: (path) => authedFetch(`${base}${path}`),
    });
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

describe('POST /api/actions — flujo del guardián', () => {
  it('allow: ejecuta y devuelve 201 con el rastro completo', async () => {
    await withHarness(async (h) => {
      const res = await h.post(pay());
      assert.equal(res.status, 201);
      const body = (await res.json()) as { action: AgentAction; decision: string; execution: { ok: boolean } };
      assert.equal(body.decision, 'allow');
      assert.equal(body.action.status, 'approved');
      assert.equal(body.execution.ok, true);
      assert.equal(body.action.decisions.length, 2);
      assert.equal(body.action.decisions[0]?.stage, 'engine');
      assert.equal(body.action.decisions[1]?.stage, 'execution');
    });
  });

  it('sign: devuelve 202 y deja la acción pendiente de firma', async () => {
    await withHarness(async (h) => {
      const res = await h.post(pay({ amountMinor: 500_00 }));
      assert.equal(res.status, 202);
      const body = (await res.json()) as { action: AgentAction; decision: string; reasons: string[] };
      assert.equal(body.decision, 'sign');
      assert.equal(body.action.status, 'pending_signature');
      assert.ok(body.action.expiresAt !== undefined);
      assert.ok(body.reasons.length > 0);
      const stored = await h.repo.findById(body.action.id);
      assert.equal(stored?.status, 'pending_signature');
    });
  });

  it('block: devuelve 403 con el motivo y también queda guardado', async () => {
    await withHarness(async (h) => {
      const res = await h.post(pay({ destination: 'crypto:binance' }));
      assert.equal(res.status, 403);
      const body = (await res.json()) as { action: AgentAction; reasons: string[] };
      assert.equal(body.action.status, 'rejected');
      assert.ok(body.reasons.join(' ').includes('prohibido'));
      const stored = await h.repo.findById(body.action.id);
      assert.equal(stored?.status, 'rejected'); // los bloqueos también se registran
    });
  });

  it('rechaza entradas inválidas con 400 y los issues de Zod', async () => {
    await withHarness(async (h) => {
      const res = await h.post(pay({ currency: 'eur' }));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; issues: Array<{ path: string }> };
      assert.equal(body.error, 'validación');
      assert.ok(body.issues.length > 0);
    });
  });

  it('registra fallos de ejecución sin perder la aprobación', async () => {
    // Política que confía en el proveedor caído: la aprobación es cosa del
    // motor, el fallo de ejecución llega DESPUÉS y queda auditado.
    const policyWithFailingVendor: Policy = {
      ...DEFAULT_POLICY,
      destinationTrusted: [...DEFAULT_POLICY.destinationTrusted, 'proveedor-caido.es'],
    };
    await withHarness(async (h) => {
      const res = await h.post(pay({ destination: 'proveedor-caido.es' }));
      assert.equal(res.status, 201);
      const body = (await res.json()) as { action: AgentAction; execution: { ok: boolean } };
      assert.equal(body.action.status, 'approved');
      assert.equal(body.execution.ok, false);
      assert.equal(body.action.decisions[1]?.decision, 'rejected');
    }, policyWithFailingVendor);
  });
});

describe('idempotencia', () => {
  it('dos envíos con la misma clave no crean dos acciones', async () => {
    await withHarness(async (h) => {
      const first = await h.post(pay(), { 'Idempotency-Key': 'clave-1' });
      const second = await h.post(pay(), { 'Idempotency-Key': 'clave-1' });
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      const a = (await first.json()) as { action: AgentAction };
      const b = (await second.json()) as { action: AgentAction; replayed: boolean };
      assert.equal(b.replayed, true);
      assert.equal(a.action.id, b.action.id);
      const all = await h.repo.list({ limit: 100 });
      assert.equal(all.length, 1);
    });
  });
});

describe('idempotencia derivada (red de seguridad, sin header)', () => {
  it('el mismo payload dentro de la ventana no se duplica', async () => {
    await withHarness(async (h) => {
      const first = await h.post(pay());
      const second = await h.post(pay());
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      const b = (await second.json()) as { action: AgentAction; replayed: boolean; idempotencyKey: string };
      assert.equal(b.replayed, true);
      assert.equal(typeof b.idempotencyKey, 'string');
      const all = await h.repo.list({ limit: 100 });
      assert.equal(all.length, 1);
    });
  });

  it('payloads distintos crean acciones distintas', async () => {
    await withHarness(async (h) => {
      await h.post(pay());
      await h.post(pay({ amountMinor: 30_00 }));
      const all = await h.repo.list({ limit: 100 });
      assert.equal(all.length, 2);
    });
  });

  it('fuera de la ventana, un reintento tardío crea otra acción (limitación documentada)', async () => {
    await withHarness(async (h) => {
      const first = await h.post(pay());
      assert.equal(first.status, 201);
      h.clock.advance(61_000);
      const late = await h.post(pay());
      assert.equal(late.status, 201);
      const all = await h.repo.list({ limit: 100 });
      assert.equal(all.length, 2);
    });
  });

  it('el header explícito manda sobre la derivación', async () => {
    await withHarness(async (h) => {
      const first = await h.post(pay(), { 'Idempotency-Key': 'explicita-1' });
      // Payload DISTINTO con la misma clave explícita → sigue siendo el mismo envío.
      const second = await h.post(pay({ amountMinor: 30_00 }), { 'Idempotency-Key': 'explicita-1' });
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      const a = (await first.json()) as { action: AgentAction };
      const b = (await second.json()) as { action: AgentAction };
      assert.equal(a.action.id, b.action.id);
      const all = await h.repo.list({ limit: 100 });
      assert.equal(all.length, 1);
    });
  });
});

describe('consultas', () => {
  it('GET /api/actions/:id devuelve la acción con su rastro', async () => {
    await withHarness(async (h) => {
      const created = (await (await h.post(pay())).json()) as { action: AgentAction };
      const res = await h.get(`/api/actions/${created.action.id}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { action: AgentAction };
      assert.equal(body.action.id, created.action.id);
      assert.equal(body.action.decisions.length, 2);
    });
  });

  it('GET /api/actions/pending devuelve la cola y expira lo vencido', async () => {
    await withHarness(async (h) => {
      await h.post(pay({ amountMinor: 500_00 }));
      let res = await h.get('/api/actions/pending');
      let body = (await res.json()) as { actions: AgentAction[] };
      assert.equal(body.actions.length, 1);

      h.clock.advance(16 * 60_000); // +16 minutos: el TTL de 15 ya venció
      res = await h.get('/api/actions/pending');
      body = (await res.json()) as { actions: AgentAction[] };
      assert.equal(body.actions.length, 0);
      const all = await h.repo.list({ limit: 100 });
      assert.equal(all[0]?.status, 'expired');
    });
  });

  it('GET /api/actions filtra por estado y valida estados desconocidos', async () => {
    await withHarness(async (h) => {
      await h.post(pay());
      await h.post(pay({ amountMinor: 500_00 }));
      const rejected = await h.get('/api/actions?status=rejected');
      assert.equal(((await rejected.json()) as { actions: unknown[] }).actions.length, 0);
      const pending = await h.get('/api/actions?status=pending_signature');
      assert.equal(((await pending.json()) as { actions: unknown[] }).actions.length, 1);
      const bad = await h.get('/api/actions?status=hackeado');
      assert.equal(bad.status, 400);
    });
  });

  it('GET /api/policy expone la política vigente', async () => {
    await withHarness(async (h) => {
      const res = await h.get('/api/policy');
      assert.equal(res.status, 200);
      const body = (await res.json()) as { policy: { id: string } };
      assert.equal(body.policy.id, 'policy-pyme-demo');
    });
  });

  it('devuelve 404 para rutas e ids inexistentes', async () => {
    await withHarness(async (h) => {
      assert.equal((await h.get('/api/actions/no-existe')).status, 404);
      assert.equal((await h.get('/ruta-inexistente')).status, 404);
    });
  });
});

describe('Fase 6: política editable y estadísticas', () => {
  it('PUT /api/policy guarda una versión nueva y el motor la usa al instante', async () => {
    await withHarness(async (h) => {
      const current = (await (await h.get('/api/policy')).json()) as { policy: Policy };
      const updated = {
        ...current.policy,
        types: {
          ...current.policy.types,
          payment: { ...current.policy.types.payment, allowLimitMinor: 600_00, cumulativeAllowLimitMinor: 600_00 },
        },
      };
      const res = await authedFetch(`${h.base}/api/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { policy: Policy };
      assert.equal(body.policy.version, current.policy.version + 1);

      // Con la política v1, 500,00 EUR exigía firma; con la v2 se aprueba solo.
      const payment = await h.post(
        pay({ amountMinor: 500_00, justification: 'Renovación anual de licencias del equipo' }),
      );
      assert.equal(payment.status, 201);
    });
  });

  it('rechaza políticas inválidas y deja la vigente intacta', async () => {
    await withHarness(async (h) => {
      const current = (await (await h.get('/api/policy')).json()) as { policy: Policy };
      const bad = {
        ...current.policy,
        types: {
          ...current.policy.types,
          payment: { ...current.policy.types.payment, allowLimitMinor: 50_00, signLimitMinor: 50_00 },
        },
      };
      const res = await authedFetch(`${h.base}/api/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400);
      const after = (await (await h.get('/api/policy')).json()) as { policy: Policy };
      assert.equal(after.policy.version, current.policy.version);
    });
  });

  it('GET /api/stats resume el libro', async () => {
    await withHarness(async (h) => {
      await h.post(pay());
      await h.post(pay({ amountMinor: 500_00 }));
      await h.post(pay({ destination: 'crypto:binance' }));
      const res = await h.get('/api/stats');
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        actions: { total: number; byStatus: Record<string, number> };
      };
      assert.equal(body.actions.total, 3);
      assert.equal(body.actions.byStatus.approved, 1);
      assert.equal(body.actions.byStatus.pending_signature, 1);
      assert.equal(body.actions.byStatus.rejected, 1);
    });
  });
});
