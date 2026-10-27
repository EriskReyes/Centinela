/**
 * Fase 4 — Rutas WebAuthn del guardián.
 *
 *   POST /api/webauthn/register/options → opciones para registrar una llave
 *   POST /api/webauthn/register/verify  → verifica y guarda la llave
 *   GET  /api/webauthn/credentials      → llaves registradas (para la UI)
 *   POST /api/actions/:id/sign/options  → reto de firma = hash(acción + decisión)
 *   POST /api/actions/:id/sign/verify   → verifica la firma y decide la acción
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { applyHumanDecision, expirePendingAction, type AgentAction } from '../domain/action.ts';
import { createWebAuthnService, type RelyingParty } from './webauthnService.ts';
import { AuthError } from './errors.ts';
import { challengeFingerprint, challengeForAction, type HumanDecision } from './signing.ts';
import type { ChallengeRepository, CredentialRepository } from './repos.ts';
import type { ActionRepository } from '../api/repository.ts';
import type { AuditService } from '../audit/service.ts';

export interface AuthRouterDeps {
  repository: ActionRepository;
  credentials: CredentialRepository;
  challenges: ChallengeRepository;
  rp: RelyingParty;
  now?: () => Date;
  idFactory?: () => string;
  /** Fase 5: registro de auditoría (firmas, fallos y expiraciones). */
  audit?: AuditService;
}

/** Usuario de la demo: en producción vendría de la sesión autenticada. */
export const DEFAULT_USER_ID = 'maria';
export const DEFAULT_USER_NAME = 'María (gerente)';

export function createAuthRouter(deps: AuthRouterDeps): express.Router {
  const now = deps.now ?? (() => new Date());
  const idFactory = deps.idFactory ?? randomUUID;
  const service = createWebAuthnService({
    rp: deps.rp,
    credentials: deps.credentials,
    challenges: deps.challenges,
    now,
  });

  const router = express.Router();

  router.post('/webauthn/register/options', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : DEFAULT_USER_ID;
      const userName = typeof body.userName === 'string' && body.userName.length > 0 ? body.userName : DEFAULT_USER_NAME;
      const options = await service.registrationOptions(userId, userName);
      res.json({ options, userId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/webauthn/register/verify', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : DEFAULT_USER_ID;
      const role = parseRole(body);
      const result = await service.verifyRegistration(userId, role, body.response as RegistrationResponseJSON);
      res.status(201).json({ ok: true, credentialId: result.credentialId, userId, role });
    } catch (err) {
      next(err);
    }
  });

  router.get('/webauthn/credentials', async (_req, res, next) => {
    try {
      const credentials = await deps.credentials.listAll();
      res.json({ credentials });
    } catch (err) {
      next(err);
    }
  });

  // Llave perdida: un administrador la revoca desde el panel. El evento queda auditado.
  router.delete('/webauthn/credentials/:id', async (req, res, next) => {
    try {
      const revoked = await deps.credentials.revoke(req.params.id, now());
      if (!revoked) {
        return res.status(404).json({ error: 'llave no encontrada o ya revocada' });
      }
      if (deps.audit !== undefined) {
        await deps.audit.append({
          eventType: 'credential_revoked',
          actionId: req.params.id,
          actor: 'admin-panel',
          decision: 'rejected',
          reason: 'llave revocada por un administrador',
          at: now(),
        });
      }
      res.json({ ok: true, credentialId: req.params.id });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Huellas de verificación para el canal cruzado: el panel (otro dispositivo)
   * muestra estos códigos y el humano los compara con el de la pantalla de
   * firma. No crea retos ni cambia nada: es una lectura pura.
   */
  router.get('/actions/:id/fingerprints', async (req, res, next) => {
    try {
      const action = await loadPendingAction(deps.repository, req.params.id, now(), idFactory, deps.audit);
      res.json({
        actionId: action.id,
        approve: challengeFingerprint(challengeForAction(action, 'approve')),
        reject: challengeFingerprint(challengeForAction(action, 'reject')),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/actions/:id/sign/options', async (req, res, next) => {
    try {
      const action = await loadPendingAction(deps.repository, req.params.id, now(), idFactory, deps.audit);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = parseDecision(body);
      const userId = parseUserId(body);
      const options = await service.signOptions(action, decision, userId);
      if (deps.audit !== undefined) {
        await deps.audit.append({
          eventType: 'signature_requested',
          actionId: action.id,
          actor: userId,
          decision,
          statusBefore: 'pending_signature',
          statusAfter: 'pending_signature',
          reason: 'reto de firma emitido (hash de los datos exactos de la acción y del progreso)',
          at: now(),
        });
      }
      // La huella sale del reto REAL que se va a firmar: la UI no puede inventarla.
      res.json({ options, action, fingerprint: challengeFingerprint(options.challenge), userId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/actions/:id/sign/verify', async (req, res, next) => {
    try {
      const action = await loadPendingAction(deps.repository, req.params.id, now(), idFactory, deps.audit);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = parseDecision(body);
      const userId = parseUserId(body);
      let credentialId: string;
      let verifiedUserId: string;
      let verifiedRole: string;
      try {
        const verified = await service.verifySignature(action, decision, userId, body.response as AuthenticationResponseJSON);
        credentialId = verified.credentialId;
        verifiedUserId = verified.userId;
        verifiedRole = verified.role;
      } catch (err) {
        if (deps.audit !== undefined) {
          await deps.audit.append({
            eventType: 'signature_failed',
            actionId: action.id,
            actor: String((body.response as { id?: unknown } | undefined)?.id ?? 'desconocida'),
            decision,
            statusBefore: action.status,
            statusAfter: action.status,
            reason: err instanceof Error ? err.message : String(err),
            at: now(),
          });
        }
        throw err;
      }
      const updated = applyHumanDecision(
        action,
        decision === 'approve' ? 'approved' : 'rejected',
        credentialId,
        verifiedUserId,
        verifiedRole,
        now(),
        idFactory,
      );
      const replaced = await deps.repository.replace(updated);
      if (!replaced) {
        throw new AuthError('la acción cambió mientras firmabas: vuelve a cargar la cola', 409);
      }
      if (deps.audit !== undefined) {
        await deps.audit.append({
          eventType: 'action_signed',
          actionId: updated.id,
          actor: credentialId,
          decision: updated.status === 'approved' ? 'approved' : decision === 'reject' ? 'rejected' : 'sign',
          statusBefore: action.status,
          statusAfter: updated.status,
          reason:
            updated.status === 'approved'
              ? `quórum alcanzado: ${updated.signatures?.length ?? 1} de ${updated.requiredSignatures ?? 1} firmas`
              : `firma verificada de ${verifiedUserId} (${(updated.signatures?.length ?? 0) + (decision === 'reject' ? 0 : 0)} de ${updated.requiredSignatures ?? 1} necesarias)`,
          at: now(),
        });
      }
      res.json({ action: updated, decision: updated.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Carga la acción y garantiza que esté pendiente de firma; expira la vencida. */
async function loadPendingAction(
  repository: ActionRepository,
  id: string,
  now: Date,
  idFactory: () => string,
  audit?: AuditService,
): Promise<AgentAction> {
  const action = await repository.findById(id);
  if (action === null) {
    throw new AuthError('acción no encontrada', 404);
  }
  if (action.status === 'pending_signature' && action.expiresAt !== undefined && now >= action.expiresAt) {
    const expired = expirePendingAction(action, now, idFactory);
    await repository.replace(expired);
    if (audit !== undefined) {
      await audit.append({
        eventType: 'action_expired',
        actionId: expired.id,
        actor: 'system',
        decision: 'expired',
        statusBefore: 'pending_signature',
        statusAfter: 'expired',
        reason: 'solicitud de firma expirada sin respuesta',
        at: now,
      });
    }
    throw new AuthError('la solicitud de firma expiró', 409);
  }
  if (action.status !== 'pending_signature') {
    throw new AuthError(`la acción no está pendiente de firma (estado: ${action.status})`, 409);
  }
  return action;
}

function parseDecision(body: Record<string, unknown>): HumanDecision {
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    throw new AuthError("decision debe ser 'approve' o 'reject'");
  }
  return decision;
}

/** Quién firma (cuarto ojos): la llave debe pertenecer a esta persona. */
function parseUserId(body: Record<string, unknown>): string {
  const userId = body?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : DEFAULT_USER_ID;
}

/**
 * Rol al registrar una llave. DEMO: en producción los roles los asigna un
 * administrador en un directorio de personas, nunca el propio usuario.
 */
function parseRole(body: Record<string, unknown>): string {
  const role = body?.role;
  return typeof role === 'string' && role.length > 0 ? role : 'empleado';
}
