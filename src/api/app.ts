/**
 * Fase 3 — La API del guardián.
 *
 * El agente de IA propone una acción por POST /api/actions. Centinela:
 *  1. valida la entrada (Zod) y asigna identidad y marca de tiempo,
 *  2. consulta la política vigente y evalúa con el motor de reglas,
 *  3. ejecuta (allow) o deja pendiente de firma (sign) o rechaza (block),
 *  4. guarda la acción con su rastro de decisiones completo — siempre.
 *
 * Respuestas: 201 allow · 202 sign · 403 block · 400 validación · 404 no encontrada.
 * Acceso (Fase 8, ver access.ts): 401 sin token · 403 si el agente sale de sus rutas.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  ACTION_STATUSES,
  AgentActionSchema,
  expirePendingAction,
  type ActionStatus,
  type AgentAction,
  type NewAgentActionInput,
} from '../domain/action.ts';
import { applyEngineDecision, evaluateAction, type EvaluationContext } from '../rules/engine.ts';
import { PolicySchema, type Policy } from '../rules/policy.ts';
import { principalOf, requireAccess, validateAccessConfig, type AccessConfig } from './access.ts';
import type { ExecutionResult } from '../execution/connector.ts';
import { executeApproved, type ExecutorDeps } from '../execution/executor.ts';
import { deriveIdempotencyKey } from './idempotency.ts';
import { normalizePath } from '../domain/paths.ts';
import type { ActionRepository } from './repository.ts';
import type { PolicyProvider } from './policyProvider.ts';
import { createAuthRouter, type AuthRouterDeps } from '../auth/routes.ts';
import { createAuditRouter } from '../audit/routes.ts';
import type { AuditService } from '../audit/service.ts';

export interface AppDeps {
  repository: ActionRepository;
  policyProvider: PolicyProvider;
  /** Fase 8: tokens del agente y del admin. Obligatorio: sin él no hay API. */
  access: AccessConfig;
  /** Reloj inyectable: los tests lo adelantan para probar expiraciones. */
  now?: () => Date;
  idFactory?: () => string;
  execute?: (action: AgentAction, now: Date) => ExecutionResult;
  /** Fase 4: rutas WebAuthn (registro de llaves y firma de acciones). */
  auth?: AuthRouterDeps;
  /** Fase 5: registro de auditoría (se registra TODO si está presente). */
  audit?: AuditService;
  /** Red de seguridad de idempotencia: ventana en segundos (por defecto 60). */
  idempotencyWindowSeconds?: number;
  /** Gancho para rutas extra ANTES del 404 final (estáticos de demo, etc.). */
  decorate?: (app: express.Express) => void;
}

const MAX_LIST = 200;

export function createApp(deps: AppDeps): express.Express {
  const now = deps.now ?? (() => new Date());
  const idFactory = deps.idFactory ?? randomUUID;
  const executorDeps: ExecutorDeps = { repository: deps.repository, execute: deps.execute, audit: deps.audit, now, idFactory };
  validateAccessConfig(deps.access);

  /** Gasto ya aprobado SIN firma por este agente dentro de la ventana de la política. */
  async function evaluationContext(action: AgentAction, policy: Policy): Promise<EvaluationContext> {
    const typePolicy = policy.types[action.actionType];
    if (typePolicy?.cumulativeWindowMinutes === undefined) {
      return { autoApprovedInWindowMinor: 0 };
    }
    const since = new Date(now().getTime() - typePolicy.cumulativeWindowMinutes * 60_000);
    return {
      autoApprovedInWindowMinor: await deps.repository.sumAutoApproved({
        agentId: action.agentId,
        actionType: action.actionType,
        currency: action.currency ?? '',
        since,
      }),
    };
  }

  // Cola por agente (en este proceso). Con varias instancias haría falta un
  // bloqueo compartido (p. ej. en Mongo); ver docs/09-produccion.md.
  const agentLocks = new Map<string, Promise<unknown>>();
  async function withAgentLock(agentId: string, fn: () => Promise<unknown>): Promise<void> {
    const previous = agentLocks.get(agentId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    agentLocks.set(agentId, tail);
    try {
      await run;
    } finally {
      if (agentLocks.get(agentId) === tail) {
        agentLocks.delete(agentId);
      }
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'centinela' });
  });

  // Fase 8: todo /api exige token; el agente solo llega a sus dos rutas.
  app.use(
    '/api',
    requireAccess(deps.access, async (agentId, req) => {
      await deps.audit?.append({
        eventType: 'access_denied',
        actionId: 'access-control',
        actor: agentId,
        decision: 'rejected',
        reason: `el agente intentó ${req.method} /api${req.path}`,
        at: now(),
      });
    }),
  );

  app.post('/api/actions', async (req, res, next) => {
    const principal = principalOf(res);
    if (principal.kind !== 'agent') {
      return res.status(403).json({ error: 'solo un agente puede proponer acciones' });
    }
    const raw = (req.body ?? {}) as NewAgentActionInput;
    // El token fija la identidad: el agente no puede proponer en nombre de otro.
    if (raw.agentId !== undefined && raw.agentId !== principal.agentId) {
      return res.status(403).json({
        error: `el token pertenece a '${principal.agentId}': no puede proponer como '${String(raw.agentId)}'`,
      });
    }
    const body: NewAgentActionInput = { ...raw, agentId: principal.agentId };
    // Rutas en forma canónica: lo que se evalúa, se firma y se ejecuta es lo mismo.
    if ((raw.actionType === 'file_change' || raw.actionType === 'program_change') && typeof raw.destination === 'string') {
      body.destination = normalizePath(raw.destination);
    }
    const headerKey = req.get('Idempotency-Key');
    const explicitKey = typeof headerKey === 'string' && headerKey.length > 0 ? headerKey : undefined;
    // Clave explícita del agente, o derivada del contenido + ventana (red de seguridad).
    const idempotencyKey =
      explicitKey ?? deriveIdempotencyKey(body, now(), deps.idempotencyWindowSeconds ?? 60);
    const replay = (existing: AgentAction) =>
      existing.agentId === principal.agentId
        ? res.status(200).json({ action: existing, replayed: true, idempotencyKey })
        : res.status(409).json({ error: 'esa clave de idempotencia ya la usó otro agente' });
    // Un agente a la vez: leer el gasto acumulado e insertar la acción es una
    // sección crítica (si no, N envíos en paralelo verían todos el mismo total).
    await withAgentLock(principal.agentId, async () => {
      try {

        const existing = await deps.repository.findByMetadataKey(idempotencyKey);
        if (existing !== null) {
          return replay(existing);
        }

        const input: NewAgentActionInput = {
          ...body,
          id: idFactory(),
          status: 'proposed',
          createdAt: now(),
          decisions: [],
          metadata: {
            ...(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {}),
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          },
        };
        const parsed = AgentActionSchema.safeParse(input);
        if (!parsed.success) {
          return res.status(400).json({
            error: 'validación',
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          });
        }
        const proposed = parsed.data;

        const policy = await deps.policyProvider.get();
        const decision = evaluateAction(proposed, policy, await evaluationContext(proposed, policy));
        const decided = applyEngineDecision(proposed, decision, now(), idFactory);
        const audit = deps.audit;

        if (decision.decision === 'allow') {
          // Primero se guarda (y se audita) la aprobación; DESPUÉS se ejecuta.
          await deps.repository.insert(decided);
          if (audit !== undefined) {
            const at = now();
            await audit.append({
              eventType: 'action_proposed',
              actionId: decided.id,
              actor: decided.agentId,
              statusBefore: 'proposed',
              statusAfter: 'proposed',
              at,
            });
            await audit.append({
              eventType: 'engine_decision',
              actionId: decided.id,
              actor: 'rules-engine',
              decision: decision.decision,
              statusBefore: 'proposed',
              statusAfter: decided.status,
              reason: decision.reasons.join(' | ') || undefined,
              policyVersion: decision.policyVersion,
              at,
            });
          }
          const { action: executed, execution } = await executeApproved(decided, executorDeps);
          return res.status(201).json({ action: executed, decision: 'allow', execution, idempotencyKey });
        }

        await deps.repository.insert(decided);
        if (audit !== undefined) {
          const at = now();
          await audit.append({
            eventType: 'action_proposed',
            actionId: decided.id,
            actor: decided.agentId,
            statusBefore: 'proposed',
            statusAfter: 'proposed',
            at,
          });
          await audit.append({
            eventType: 'engine_decision',
            actionId: decided.id,
            actor: 'rules-engine',
            decision: decision.decision,
            statusBefore: 'proposed',
            statusAfter: decided.status,
            reason: decision.reasons.join(' | ') || undefined,
            policyVersion: decision.policyVersion,
            at,
          });
        }
        if (decision.decision === 'sign') {
          return res.status(202).json({
            action: decided,
            decision: 'sign',
            reasons: decision.reasons,
            expiresAt: decided.expiresAt,
            idempotencyKey,
          });
        }
        return res.status(403).json({ action: decided, decision: 'block', reasons: decision.reasons, idempotencyKey });
      } catch (err) {
        // Carrera entre dos envíos paralelos con la misma clave: el índice único
        // ha rechazado el segundo; devolvemos la acción que ganó la carrera.
        if ((err as { code?: number }).code === 11000) {
          const existing = await deps.repository.findByMetadataKey(idempotencyKey);
          if (existing !== null) {
            return replay(existing);
          }
        }
        next(err);
      }
    });
  });

  app.get('/api/actions/pending', async (_req, res, next) => {
    try {
      const current = now();
      const pending = await deps.repository.listPending();
      const active: AgentAction[] = [];
      for (const action of pending) {
        const updated = expirePendingAction(action, current, idFactory);
        if (updated !== action) {
          await deps.repository.replace(updated, { status: 'pending_signature' });
          if (deps.audit !== undefined) {
            await deps.audit.append({
              eventType: 'action_expired',
              actionId: updated.id,
              actor: 'system',
              decision: 'expired',
              statusBefore: 'pending_signature',
              statusAfter: 'expired',
              reason: 'solicitud de firma expirada sin respuesta',
              at: current,
            });
          }
        }
        if (updated.status === 'pending_signature') {
          active.push(updated);
        }
      }
      res.json({ actions: active, count: active.length });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/actions/:id', async (req, res, next) => {
    try {
      const action = await deps.repository.findById(req.params.id);
      const principal = principalOf(res);
      // Un agente solo ve las suyas; las ajenas "no existen" (no se filtra ni su id).
      if (action === null || (principal.kind === 'agent' && action.agentId !== principal.agentId)) {
        return res.status(404).json({ error: 'acción no encontrada' });
      }
      res.json({ action });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/actions', async (req, res, next) => {
    try {
      const rawStatus = typeof req.query.status === 'string' && req.query.status.length > 0 ? req.query.status : undefined;
      if (rawStatus !== undefined && !(ACTION_STATUSES as readonly string[]).includes(rawStatus)) {
        return res.status(400).json({ error: `estado '${rawStatus}' no válido`, valid: ACTION_STATUSES });
      }
      const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIST) : 100;
      const actions = await deps.repository.list({
        status: rawStatus as ActionStatus | undefined,
        agentId: typeof req.query.agentId === 'string' ? req.query.agentId : undefined,
        actionType: typeof req.query.actionType === 'string' ? req.query.actionType : undefined,
        limit,
      });
      res.json({ actions, count: actions.length });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/policy', async (_req, res, next) => {
    try {
      res.json({ policy: await deps.policyProvider.get() });
    } catch (err) {
      next(err);
    }
  });

  // Fase 6: el panel ajusta los límites sin tocar código. La versión la asigna
  // el servidor (la anterior + 1) y el cambio queda auditado.
  app.put('/api/policy', async (req, res, next) => {
    try {
      const current = await deps.policyProvider.get();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = PolicySchema.safeParse({ ...body, id: current.id, version: current.version + 1 });
      if (!parsed.success) {
        return res.status(400).json({
          error: 'validación',
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }
      const saved = await deps.policyProvider.set(parsed.data);
      if (deps.audit !== undefined) {
        await deps.audit.append({
          eventType: 'policy_updated',
          actionId: saved.id,
          actor: 'admin-panel',
          reason: `política actualizada a la versión ${saved.version}`,
          policyVersion: saved.version,
          at: now(),
        });
      }
      res.json({ policy: saved });
    } catch (err) {
      next(err);
    }
  });

  // Fase 6: resumen para el panel.
  app.get('/api/stats', async (_req, res, next) => {
    try {
      const actions = await deps.repository.list({ limit: 1000 });
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      for (const action of actions) {
        byStatus[action.status] = (byStatus[action.status] ?? 0) + 1;
        byType[action.actionType] = (byType[action.actionType] ?? 0) + 1;
      }
      // La integridad de la cadena va aparte (/api/audit/verify): recorrerla
      // entera en cada carga del resumen no escala con el tamaño del registro.
      res.json({ actions: { total: actions.length, byStatus, byType } });
    } catch (err) {
      next(err);
    }
  });

  if (deps.auth !== undefined) {
    // Lo que firman los humanos también se ejecuta, con el mismo conector.
    app.use('/api', createAuthRouter({ execute: deps.execute, ...deps.auth }));
  }

  if (deps.audit !== undefined) {
    app.use('/api', createAuditRouter({ audit: deps.audit, repository: deps.repository }));
  }

  deps.decorate?.(app);

  app.use((_req, res) => {
    res.status(404).json({ error: 'ruta no encontrada' });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Errores con código HTTP propio (AuthError, etc.): se exponen tal cual.
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    console.error('[centinela] error no controlado:', err);
    res.status(500).json({ error: 'error interno', detail: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
