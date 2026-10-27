/**
 * Integración contra MongoDB real. Si no hay un mongod accesible, la suite
 * completa se salta sola (skip) para que `pnpm test` siga siendo útil sin
 * base de datos. Base de datos usada: centinela_test.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { ActionModel, AuditModel, AuditSeqModel, ChallengeModel, CredentialModel, PolicyModel } from '../db/models.ts';
import { createApp } from './app.ts';
import { MongoActionRepository } from './mongoRepository.ts';
import { MongoPolicyProvider } from './policyProvider.ts';
import { MongoChallengeRepository, MongoCredentialRepository } from '../auth/repos.ts';
import { FakeAuthenticator } from '../auth/testkit.ts';
import type { RelyingParty } from '../auth/webauthnService.ts';
import { MongoAuditRepository } from '../audit/repository.ts';
import { createAuditService } from '../audit/service.ts';
import { TEST_ACCESS, authedFetch } from './testAccess.ts';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/centinela_test';

let available = false;
try {
  await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 1500 });
  available = true;
} catch {
  available = false;
}

const RP: RelyingParty = { rpName: 'Centinela', rpID: 'localhost', origin: 'http://localhost:4000' };

const pay = (over: Record<string, unknown> = {}) => ({
  agentId: 'agente-compras',
  actionType: 'payment',
  amountMinor: 25_00,
  currency: 'EUR',
  destination: 'amazon.es',
  justification: 'Compra de material de oficina aprobada en presupuesto mensual',
  ...over,
});

let keyCounter = 0;
const uniqueKey = () => `it-${++keyCounter}`;

describe('integración real con MongoDB', { skip: !available }, () => {
  before(async () => {
    if (!available) return;
    await ActionModel.deleteMany({});
    await PolicyModel.deleteMany({});
    await CredentialModel.deleteMany({});
    await ChallengeModel.deleteMany({});
    await AuditModel.deleteMany({});
    await AuditSeqModel.deleteMany({});
    // Migración: versiones antiguas creaban un índice único sobre policy.id.
    try {
      await PolicyModel.collection.dropIndex('id_1');
    } catch {
      // el índice no existía: nada que migrar
    }
    await PolicyModel.syncIndexes();
  });

  after(async () => {
    if (available) {
      await mongoose.disconnect();
    }
  });

  it('guarda, decide y consulta acciones en MongoDB (flujo completo)', async () => {
    const app = createApp({ repository: new MongoActionRepository(), policyProvider: new MongoPolicyProvider(), access: TEST_ACCESS });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (body: unknown) =>
        authedFetch(`${base}/api/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      // Un pago que se permite y ejecuta.
      const allowed = await post(pay());
      assert.equal(allowed.status, 201);

      // Un pago que queda pendiente de firma.
      const signRequest = await post(pay({ amountMinor: 500_00 }));
      assert.equal(signRequest.status, 202);

      // Un bloqueo que también queda guardado.
      const blocked = await post(pay({ destination: 'crypto:binance' }));
      assert.equal(blocked.status, 403);

      const pending = (await (await authedFetch(`${base}/api/actions/pending`)).json()) as { actions: Array<{ id: string }> };
      assert.equal(pending.actions.length, 1);

      const list = (await (await authedFetch(`${base}/api/actions?limit=10`)).json()) as { actions: unknown[] };
      assert.equal(list.actions.length, 3);

      const policy = (await (await authedFetch(`${base}/api/policy`)).json()) as { policy: { id: string; version: number } };
      assert.equal(policy.policy.id, 'policy-pyme-demo');
      assert.equal(policy.policy.version, 1);

      // La política se sembró exactamente una vez.
      assert.equal(await PolicyModel.countDocuments(), 1);
      assert.equal(await ActionModel.countDocuments(), 3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('hace valer la idempotencia también en MongoDB', async () => {
    const app = createApp({ repository: new MongoActionRepository(), policyProvider: new MongoPolicyProvider(), access: TEST_ACCESS });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const headers = { 'content-type': 'application/json', 'Idempotency-Key': 'clave-mongo-1' };
      const first = await authedFetch(`${base}/api/actions`, { method: 'POST', headers, body: JSON.stringify(pay()) });
      const second = await authedFetch(`${base}/api/actions`, { method: 'POST', headers, body: JSON.stringify(pay()) });
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      const a = (await first.json()) as { action: { id: string } };
      const b = (await second.json()) as { action: { id: string }; replayed: boolean };
      assert.equal(b.replayed, true);
      assert.equal(a.action.id, b.action.id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('registra una llave y firma una acción pendiente contra MongoDB real', async () => {
    const repository = new MongoActionRepository();
    const credentials = new MongoCredentialRepository();
    const challenges = new MongoChallengeRepository();
    const app = createApp({
      access: TEST_ACCESS,
      repository,
      policyProvider: new MongoPolicyProvider(),
      auth: { repository, credentials, challenges, rp: RP },
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = async (path: string, body: unknown) => {
        const res = await authedFetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };

      // 1. Registrar la llave virtual (con rol autorizador: la política lo exige).
      const authenticator = new FakeAuthenticator(RP.rpID, RP.origin);
      const regOptions = await post('/api/webauthn/register/options', {});
      const registered = await post('/api/webauthn/register/verify', {
        role: 'autorizador',
        response: authenticator.register(regOptions.body.options),
      });
      assert.equal(registered.status, 201);
      assert.equal(await CredentialModel.countDocuments(), 1);

      // 2. Proponer un pago que exige firma (499,00 €: por encima del límite
      //    automático pero por debajo del quórum de dos firmas).
      const proposed = await post('/api/actions', pay({ amountMinor: 499_00 }));
      assert.equal(proposed.status, 202);
      const actionId = proposed.body.action.id as string;

      // 3. Firmar: el reto es el hash de los datos exactos de la acción.
      const signOptions = await post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
      assert.equal(signOptions.status, 200);
      const signed = await post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(signOptions.body.options),
      });
      assert.equal(signed.status, 200);
      assert.equal(signed.body.action.status, 'approved');

      // 4. Persistido con el rastro completo.
      const doc = (await ActionModel.findById(actionId).lean()) as unknown as {
        status: string;
        decisions: Array<{ stage: string; decision: string; by: string }>;
      };
      assert.equal(doc.status, 'approved');
      assert.equal(doc.decisions.length, 2);
      assert.equal(doc.decisions[1]?.stage, 'signature');
      assert.equal(doc.decisions[1]?.decision, 'approved');
      assert.equal(doc.decisions[1]?.by, authenticator.id);

      // 5. La firma no se puede reutilizar: la acción ya está decidida (409),
      //    y el reto además se consumió en la verificación anterior.
      const replay = await post(`/api/actions/${actionId}/sign/verify`, {
        decision: 'approve',
        response: authenticator.assert(signOptions.body.options),
      });
      assert.equal(replay.status, 409);

      // 6. El contador anti-replay quedó actualizado en Mongo.
      const cred = (await CredentialModel.findOne({ _id: authenticator.id }).lean()) as unknown as { counter: number };
      assert.equal(cred.counter, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('el registro de auditoría encadena, verifica y detecta manipulación en MongoDB', async () => {
    const repository = new MongoActionRepository();
    const audit = createAuditService({ repository: new MongoAuditRepository() });
    const app = createApp({
      access: TEST_ACCESS,
      repository,
      policyProvider: new MongoPolicyProvider(),
      audit,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (body: unknown) =>
        authedFetch(`${base}/api/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      await post(pay({ amountMinor: 26_00 }));
      await post(pay({ amountMinor: 501_00 }));
      await post(pay({ amountMinor: 26_00, destination: 'crypto:otro-exchange' }));

      // 7 entradas: 3 (allow) + 2 (sign) + 2 (block).
      assert.equal(await AuditModel.countDocuments(), 7);

      // La cadena verifica íntegra.
      const verify = (await (await authedFetch(`${base}/api/audit/verify`)).json()) as {
        ok: boolean;
        total: number;
        firstBreak: number | null;
      };
      assert.equal(verify.ok, true);
      assert.equal(verify.total, 7);

      // Un atacante altera el motivo de la entrada 3.
      await AuditModel.updateOne({ seq: 3 }, { $set: { reason: 'manipulado' } });
      const broken = (await (await authedFetch(`${base}/api/audit/verify`)).json()) as {
        ok: boolean;
        firstBreak: number | null;
      };
      assert.equal(broken.ok, false);
      assert.equal(broken.firstBreak, 3);

      // El listado con filtro funciona contra Mongo.
      const filtered = (await (await authedFetch(`${base}/api/audit?eventType=engine_decision&limit=20`)).json()) as {
        entries: unknown[];
      };
      assert.equal(filtered.entries.length, 3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('el panel actualiza la política y el motor usa la versión nueva', async () => {
    const repository = new MongoActionRepository();
    const audit = createAuditService({ repository: new MongoAuditRepository() });
    const app = createApp({
      access: TEST_ACCESS,
      repository,
      policyProvider: new MongoPolicyProvider(),
      audit,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (body: unknown) =>
        authedFetch(`${base}/api/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': uniqueKey() },
          body: JSON.stringify(body),
        });

      // Con la política v1, 500,00 EUR exige firma.
      const before = await post(pay({ amountMinor: 500_00 }));
      assert.equal(before.status, 202);

      // El panel sube el límite de aprobación automática a 600,00 EUR.
      const policy = (await (await authedFetch(`${base}/api/policy`)).json()) as { policy: Record<string, any> };
      const updated = {
        ...policy.policy,
        types: {
          ...policy.policy.types,
          payment: { ...policy.policy.types.payment, allowLimitMinor: 600_00, cumulativeAllowLimitMinor: 600_00 },
        },
      };
      const put = await authedFetch(`${base}/api/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      });
      assert.equal(put.status, 200);

      // El mismo pago ahora se aprueba automáticamente.
      const after = await post(pay({ amountMinor: 500_00 }));
      assert.equal(after.status, 201);

      // La versión 2 quedó persistida y el cambio auditado.
      assert.equal(await PolicyModel.countDocuments(), 2);
      assert.equal(await AuditModel.countDocuments({ eventType: 'policy_updated' }), 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('la idempotencia derivada (sin header) evita duplicados también en Mongo', async () => {
    // Los tests anteriores ya acumularon gasto sin firma para este agente:
    // se parte de cero para que el tope acumulado no interfiera.
    await ActionModel.deleteMany({});
    const app = createApp({ repository: new MongoActionRepository(), policyProvider: new MongoPolicyProvider(), access: TEST_ACCESS });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (body: unknown) =>
        authedFetch(`${base}/api/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const first = await post(pay({ amountMinor: 27_00 }));
      const second = await post(pay({ amountMinor: 27_00 }));
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      const a = (await first.json()) as { action: { id: string } };
      const b = (await second.json()) as { action: { id: string }; replayed: boolean };
      assert.equal(b.replayed, true);
      assert.equal(a.action.id, b.action.id);

      const list = (await (await authedFetch(`${base}/api/actions?limit=100`)).json()) as { actions: Array<{ id: string }> };
      assert.equal(list.actions.filter((x) => x.id === a.action.id).length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
