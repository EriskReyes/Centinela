import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryAuditRepository } from './repository.ts';
import { createAuditService } from './service.ts';
import {
  createFileAnchorSink,
  createWebhookAnchorSink,
  isAnchorFailure,
  readLastAnchorSuccess,
  readLastJournalEntry,
  type AnchorFailureRecord,
  type AnchorRecord,
} from './anchor.ts';

const event = () =>
  ({
    eventType: 'action_proposed',
    actionId: 'a',
    actor: 'x',
    at: new Date('2026-10-26T10:00:00Z'),
  }) as const;

describe('anclaje externo de la auditoría', () => {
  it('publica la cabeza cada N entradas al archivo y al webhook', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'centinela-anchor-'));
    const filePath = path.join(dir, 'anchors.log');
    const received: AnchorRecord[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push(JSON.parse(body) as AnchorRecord);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const sink = async (anchor: AnchorRecord) => {
      await createFileAnchorSink(filePath)(anchor);
      await createWebhookAnchorSink(`http://127.0.0.1:${port}/anchor`)(anchor);
    };
    const audit = createAuditService({
      repository: new InMemoryAuditRepository(),
      anchorEvery: 2,
      anchorSink: sink,
    });
    for (let i = 0; i < 5; i++) {
      await audit.append(event());
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));

    assert.equal(received.length, 2);
    assert.equal(received[0]?.seq, 2);
    assert.equal(received[1]?.seq, 4);
    assert.equal(received[0]?.count, 2);
    assert.equal(received[0]?.hash.length, 43);

    const last = await readLastAnchorSuccess(filePath);
    assert.deepEqual(last, received[1]);

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);

    const state = await audit.anchorState();
    assert.equal(state.head?.seq, 5);
    assert.equal(state.head?.hash.length, 43);

    await rm(dir, { recursive: true, force: true });
  });

  it('un anclaje fallido queda en la cadena Y en el diario externo, con su código HTTP', async () => {
    const failures: AnchorFailureRecord[] = [];
    const repository = new InMemoryAuditRepository();
    const audit = createAuditService({
      repository,
      anchorEvery: 1,
      anchorSink: async () => {
        throw new Error('anclaje webhook fallido: HTTP 503');
      },
      journalFailure: async (failure) => {
        failures.push(failure);
      },
      readJournal: () => Promise.resolve(failures[failures.length - 1] ?? null),
      readLastAnchor: () => Promise.resolve(null),
    });

    const entry = await audit.append(event());
    assert.equal(entry.seq, 1);

    // 1) El evento anchor_failed vive en la cadena (diagnóstico).
    const all = await repository.allSorted();
    assert.equal(all.length, 2);
    assert.equal(all[1]?.eventType, 'anchor_failed');
    assert.ok(all[1]?.reason?.includes('HTTP 503'));

    // 2) El fallo también quedó en el diario externo (fuera de Mongo).
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.kind, 'failure');
    assert.equal(failures[0]?.httpStatus, 503);

    // 3) Y la señal de silencio salta aunque borraran el evento de la cadena.
    const state = await audit.anchorState();
    const attempt = state.lastAttempt;
    assert.ok(attempt !== null && isAnchorFailure(attempt));
    if (attempt !== null && isAnchorFailure(attempt)) {
      assert.equal(attempt.kind, 'failure');
      assert.equal(attempt.httpStatus, 503);
    }
    assert.equal(state.lastAnchor, null);
    assert.equal(state.stale, true);
    assert.ok(state.staleReason?.includes('ningún anclaje'));
  });

  it('sin huecos ni retrasos, la señal de silencio está en calma', async () => {
    let t = new Date('2026-10-26T10:00:00Z');
    const anchors: AnchorRecord[] = [];
    const audit = createAuditService({
      repository: new InMemoryAuditRepository(),
      anchorEvery: 2,
      now: () => t,
      anchorSink: async (anchor) => {
        anchors.push(anchor);
      },
      readLastAnchor: () => Promise.resolve(anchors[anchors.length - 1] ?? null),
      readJournal: () => Promise.resolve(anchors[anchors.length - 1] ?? null),
    });

    await audit.append(event());
    await audit.append(event()); // ancla #2
    const calm = await audit.anchorState();
    assert.equal(calm.stale, false);
    assert.equal(calm.lastAnchor?.seq, 2);
  });

  it('silencio prolongado → stale por tiempo, aunque no haya eventos de fallo', async () => {
    let t = new Date('2026-10-26T10:00:00Z');
    const anchors: AnchorRecord[] = [];
    const audit = createAuditService({
      repository: new InMemoryAuditRepository(),
      anchorEvery: 2,
      now: () => t,
      anchorStalenessMinutes: 60,
      anchorSink: async (anchor) => {
        anchors.push(anchor);
      },
      readLastAnchor: () => Promise.resolve(anchors[anchors.length - 1] ?? null),
      readJournal: () => Promise.resolve(anchors[anchors.length - 1] ?? null),
    });

    await audit.append(event());
    await audit.append(event()); // ancla #2 a las 10:00
    assert.equal((await audit.anchorState()).stale, false);

    t = new Date(t.getTime() + 61 * 60_000); // 61 minutos sin anclar nada
    const state = await audit.anchorState();
    assert.equal(state.stale, true);
    assert.ok(state.staleReason?.includes('umbral 60'));
  });

  it('la cadena avanzando sin anclar → stale por ritmo (copia externa estancada)', async () => {
    const anchors: AnchorRecord[] = [];
    let pinnedExternal: AnchorRecord | null = null;
    const audit = createAuditService({
      repository: new InMemoryAuditRepository(),
      anchorEvery: 2,
      anchorSink: async (anchor) => {
        anchors.push(anchor);
      },
      // La copia externa se quedó congelada en el ancla #2 (o fue borrada hasta ahí).
      readLastAnchor: () => Promise.resolve(pinnedExternal),
      readJournal: () => Promise.resolve(anchors[anchors.length - 1] ?? null),
    });

    await audit.append(event());
    await audit.append(event()); // ancla #2
    pinnedExternal = anchors[0] ?? null; // la copia externa solo conserva #2

    await audit.append(event());
    await audit.append(event()); // ancla #4
    await audit.append(event());
    await audit.append(event()); // ancla #6

    const state = await audit.anchorState();
    assert.equal(state.head?.seq, 6);
    assert.equal(state.stale, true);
    assert.ok(state.staleReason?.includes('sin anclar'));
  });

  it('un anclaje fallido no detiene el sistema (se registra y se sigue)', async () => {
    const audit = createAuditService({
      repository: new InMemoryAuditRepository(),
      anchorEvery: 1,
      anchorSink: async () => {
        throw new Error('webhook caído');
      },
    });
    const entry = await audit.append(event());
    assert.equal(entry.seq, 1);
  });

  it('sin anclas publicadas, el estado informa la cabeza y un ancla nula', async () => {
    const audit = createAuditService({
      repository: new InMemoryAuditRepository(),
      anchorEvery: 50,
      readLastAnchor: () => Promise.resolve(null),
      readJournal: () => Promise.resolve(null),
    });
    const state = await audit.anchorState();
    assert.equal(state.head, null);
    assert.equal(state.lastAnchor, null);
    await audit.append(event());
    const after = await audit.anchorState();
    assert.equal(after.head?.seq, 1);
    assert.equal(after.lastAnchor, null);
    void readLastJournalEntry;
  });
});
