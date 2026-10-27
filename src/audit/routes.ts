/**
 * Fase 5 — Consultas del registro de auditoría.
 *
 *   GET /api/audit         → listado filtrable (actionId, eventType, actor, limit)
 *   GET /api/audit/verify  → verificación de integridad de la cadena de hashes
 *   GET /api/audit/:id     → línea temporal de una acción + la acción con su rastro embebido
 */
import express from 'express';
import { AUDIT_EVENT_TYPES, type AuditEventType } from './events.ts';
import type { AuditService } from './service.ts';
import type { ActionRepository } from '../api/repository.ts';

export interface AuditRouterDeps {
  audit: AuditService;
  repository: ActionRepository;
}

const MAX_LIST = 500;

export function createAuditRouter(deps: AuditRouterDeps): express.Router {
  const router = express.Router();

  router.get('/audit/verify', async (_req, res, next) => {
    try {
      res.json({ ...(await deps.audit.verify()), verifiedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // Cabeza actual de la cadena + último anclaje externo (para el panel).
  router.get('/audit/anchor', async (_req, res, next) => {
    try {
      res.json(await deps.audit.anchorState());
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit/:actionId', async (req, res, next) => {
    try {
      const [action, entries] = await Promise.all([
        deps.repository.findById(req.params.actionId),
        deps.audit.timeline(req.params.actionId),
      ]);
      if (action === null && entries.length === 0) {
        return res.status(404).json({ error: 'no hay rastro de esa acción' });
      }
      res.json({ action, entries });
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit', async (req, res, next) => {
    try {
      const rawEventType = typeof req.query.eventType === 'string' && req.query.eventType.length > 0 ? req.query.eventType : undefined;
      if (rawEventType !== undefined && !(AUDIT_EVENT_TYPES as readonly string[]).includes(rawEventType)) {
        return res.status(400).json({ error: `eventType '${rawEventType}' no válido`, valid: AUDIT_EVENT_TYPES });
      }
      const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIST) : 100;
      const entries = await deps.audit.list({
        actionId: typeof req.query.actionId === 'string' ? req.query.actionId : undefined,
        eventType: rawEventType as AuditEventType | undefined,
        actor: typeof req.query.actor === 'string' ? req.query.actor : undefined,
        limit,
      });
      res.json({ entries, count: entries.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
