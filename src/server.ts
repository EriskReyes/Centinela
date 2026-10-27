/**
 * Fase 3 + 4 — Punto de entrada del servidor.
 *
 * Modos:
 *   CENTINELA_STORE=mongo (por defecto) → MongoDB local (mongodb://127.0.0.1:27017/centinela)
 *   CENTINELA_STORE=mock                → repositorios en memoria (demo sin MongoDB)
 *
 * WebAuthn: la página de firma está en http://localhost:4000/firmar (el RP ID
 * es 'localhost': ábrela con ese host, no con 127.0.0.1).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { createApp } from './api/app.ts';
import { generateToken, parseAgentTokens, validateAccessConfig, type AccessConfig } from './api/access.ts';
import { MongoActionRepository } from './api/mongoRepository.ts';
import { InMemoryPolicyProvider, MongoPolicyProvider, type PolicyProvider } from './api/policyProvider.ts';
import { InMemoryActionRepository, type ActionRepository } from './api/repository.ts';
import {
  InMemoryChallengeRepository,
  InMemoryCredentialRepository,
  MongoChallengeRepository,
  MongoCredentialRepository,
  type ChallengeRepository,
  type CredentialRepository,
} from './auth/repos.ts';
import type { RelyingParty } from './auth/webauthnService.ts';
import { InMemoryAuditRepository, MongoAuditRepository } from './audit/repository.ts';
import { createAuditService } from './audit/service.ts';
import {
  createJournalFailureSink,
  defaultAnchorConfig,
  readLastAnchorSuccess,
  readLastJournalEntry,
} from './audit/anchor.ts';
import { PolicyModel } from './db/models.ts';

const PORT = Number(process.env.PORT ?? 4000);
// Por defecto solo 127.0.0.1. Para el despliegue de DOS dispositivos (el móvil
// firma desde otro aparato): HOST=0.0.0.0 y, por WebAuthn, hace falta un origen
// seguro con dominio real (túnel HTTPS). Ver docs/08-canal-cruzado.md.
const HOST = process.env.HOST ?? '127.0.0.1';
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/centinela';
const STORE = process.env.CENTINELA_STORE ?? 'mongo';

// Fase 8: tokens separados para el agente y para el admin (panel y firma).
// Sin configurar → se generan al vuelo SOLO para desarrollo y se imprimen una vez.
const adminFromEnv = process.env.CENTINELA_ADMIN_TOKEN;
const agentsFromEnv = process.env.CENTINELA_AGENT_TOKENS;
const generatedTokens = adminFromEnv === undefined || agentsFromEnv === undefined;
const adminToken = adminFromEnv ?? generateToken();
let agentTokens: Record<string, string>;
let access: AccessConfig;
try {
  agentTokens = agentsFromEnv !== undefined ? parseAgentTokens(agentsFromEnv) : { 'agente-compras': generateToken() };
  access = { adminToken, agentTokens };
  validateAccessConfig(access);
} catch (err) {
  console.error('[centinela] Configuración de acceso inválida:', err instanceof Error ? err.message : err);
  process.exit(1);
}

const rp: RelyingParty = {
  rpName: process.env.RP_NAME ?? 'Centinela',
  rpID: process.env.RP_ID ?? 'localhost',
  origin: process.env.ORIGIN ?? 'http://localhost:4000',
};

let repository: ActionRepository;
let policyProvider: PolicyProvider;
let credentials: CredentialRepository;
let challenges: ChallengeRepository;
let auditRepository: InMemoryAuditRepository | MongoAuditRepository;

if (STORE === 'mock') {
  repository = new InMemoryActionRepository();
  policyProvider = new InMemoryPolicyProvider();
  credentials = new InMemoryCredentialRepository();
  challenges = new InMemoryChallengeRepository();
  auditRepository = new InMemoryAuditRepository();
} else {
  try {
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 3000 });
  } catch (err) {
    console.error(`[centinela] No se pudo conectar a MongoDB en ${MONGO_URL}`);
    console.error('[centinela] Detalle:', err instanceof Error ? err.message : err);
    console.error('[centinela] Arranca mongod o ejecuta con CENTINELA_STORE=mock');
    process.exit(1);
  }
  repository = new MongoActionRepository();
  policyProvider = new MongoPolicyProvider();
  credentials = new MongoCredentialRepository();
  challenges = new MongoChallengeRepository();
  auditRepository = new MongoAuditRepository();
  // Migración: versiones antiguas creaban un índice único sobre policy.id;
  // ahora cada versión es un documento y la unicidad es (id, version).
  try {
    await PolicyModel.collection.dropIndex('id_1');
  } catch {
    // el índice no existía: nada que migrar
  }
  await PolicyModel.syncIndexes();
}

const anchorConfig = defaultAnchorConfig();
const audit = createAuditService({
  repository: auditRepository,
  anchorEvery: Number(process.env.ANCHOR_EVERY ?? 50),
  anchorSink: anchorConfig.sinks,
  journalFailure: createJournalFailureSink(anchorConfig.filePath),
  readJournal: () => readLastJournalEntry(anchorConfig.filePath),
  readLastAnchor: () => readLastAnchorSuccess(anchorConfig.filePath),
  anchorStalenessMinutes: Number(process.env.ANCHOR_STALENESS_MINUTES ?? 60),
});

// Página de firma (demo) y bundle del cliente WebAuthn; el panel llega en la Fase 6.
const here = path.dirname(fileURLToPath(import.meta.url));

const app = createApp({
  repository,
  policyProvider,
  access,
  audit,
  idempotencyWindowSeconds: Number(process.env.IDEMPOTENCY_WINDOW_SECONDS ?? 60),
  auth: { repository, credentials, challenges, rp, audit },
  decorate: (instance) => {
    instance.get('/firmar', (_req, res) => {
      res.sendFile(path.join(here, 'auth', 'firmar.html'));
    });
    instance.get('/webauthn.js', (_req, res) => {
      res.sendFile(
        path.join(here, '..', 'node_modules', '@simplewebauthn', 'browser', 'dist', 'bundle', 'index.umd.min.js'),
      );
    });
    instance.get('/panel', (_req, res) => {
      res.sendFile(path.join(here, 'web', 'panel.html'));
    });
    instance.get('/', (_req, res) => {
      res.redirect('/panel');
    });
  },
});

app.listen(PORT, HOST, () => {
  console.log(`Centinela API en http://localhost:${PORT} (store: ${STORE}, host: ${HOST})`);
  console.log(`Página de firma: http://localhost:${PORT}/firmar`);
  console.log(`Panel (libro mayor): http://localhost:${PORT}/panel`);
  if (HOST !== '127.0.0.1') {
    console.warn('[centinela] El servidor está expuesto a la red: asegúrate de usar HTTPS y un RP_ID de dominio real.');
  }
  if (generatedTokens) {
    console.warn('[centinela] Tokens generados para ESTA ejecución (define CENTINELA_ADMIN_TOKEN y CENTINELA_AGENT_TOKENS en .env):');
    console.warn(`  admin (panel y firma):  ${adminToken}`);
    for (const [agentId, token] of Object.entries(agentTokens)) {
      console.warn(`  agente '${agentId}':  ${token}`);
    }
    console.warn('[centinela] Nunca le des el token de admin al agente.');
  }
});
