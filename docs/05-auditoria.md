# Fase 5 — El registro de auditoría

> Implementación: [`src/audit/`](../src/audit/).

## La regla de oro

**Nada ocurre sin dejar rastro.** Cada propuesta, cada decisión del motor, cada ejecución, cada petición de firma, cada firma (válida o fallida) y cada expiración queda registrada — incluidos los bloqueos. Un bloqueo sin registro no es un bloqueo: es un agujero.

## Dos capas complementarias

1. **Rastro embebido** (`decisions[]` dentro de cada acción): se escribe atómicamente con la acción en MongoDB. Es la fuente de verdad operativa.
2. **Registro encadenado** (colección `auditentries`): apéndice inmutable a prueba de manipulaciones. Cada entrada guarda el hash SHA-256 de su contenido y el hash del eslabón anterior.

```
entrada 1                  entrada 2                  entrada 3
┌────────────────────┐     ┌────────────────────┐     ┌────────────────────┐
│ contentHash: h1    │     │ contentHash: h2    │     │ contentHash: h3    │
│ prevHash: GÉNESIS  │◄────│ prevHash: H1       │◄────│ prevHash: H2       │
└────────────────────┘     └────────────────────┘     └────────────────────┘
   H1 = sha256(h1 + GÉNESIS)   H2 = sha256(h2 + H1)
```

Alterar cualquier campo (o cualquier hash) rompe la cadena: `GET /api/audit/verify` recomputa todo el registro y dice exactamente **en qué entrada** se rompió la cadena.

## Eventos registrados

| eventType | actor | cuándo |
|---|---|---|
| `action_proposed` | el agente | al llegar una propuesta |
| `engine_decision` | `rules-engine` | decisión allow/sign/block con motivo y versión de política |
| `action_executed` | el conector | resultado (éxito o fallo) de la ejecución |
| `signature_requested` | el usuario demo | al emitir un reto de firma |
| `action_signed` | la llave WebAuthn | firma verificada (aprobada/rechazada) |
| `signature_failed` | la llave (o `desconocida`) | verificación fallida, con el motivo |
| `action_expired` | `system` | solicitud de firma vencida |

## El silencio también es una señal

Un anclaje fallido se registra en DOS sitios: como evento `anchor_failed` dentro de la cadena (diagnóstico) y en el **diario externo** (una línea `{"kind":"failure",…}` en el mismo `anchors.log`). Pero ambas señales podrían borrarse junto con la cadena por un admin de Mongo. Por eso hay una tercera, más difícil de ocultar: **el silencio**. El panel compara el último anclaje **externo** exitoso contra un umbral (`ANCHOR_STALENESS_MINUTES`, por defecto 60) y contra el ritmo de la cadena (`ANCHOR_EVERY`): si hace demasiado tiempo que no ancla nada o la cadena avanzó más de lo previsto sin anclar, muestra una alerta — aunque no haya ningún evento de fallo visible. Un admin de Mongo puede borrar eventos, pero no puede fabricar un anclaje reciente en el archivo que vive fuera de su alcance.

## Endpoints

| Método | Ruta | Qué devuelve |
|---|---|---|
| `GET` | `/api/audit` | listado filtrable (`actionId`, `eventType`, `actor`, `limit`) |
| `GET` | `/api/audit/verify` | `{ ok, total, firstBreak }` — integridad de la cadena completa |
| `GET` | `/api/audit/anchor` | cabeza + último anclaje exitoso + último intento (éxito/fallo) + `stale` |
| `GET` | `/api/audit/:id` | línea temporal de una acción + la acción con su rastro embebido |

## Honestidad técnica

La doble escritura (acción + registro) no es transaccional en MongoDB standalone: si escribir el registro fallara, la acción ya estaría guardada con su rastro embebido y la API devuelve 500 para que el agente reintente (con `Idempotency-Key`). En producción, transacciones multi-documento o un log externo resolverían la consistencia estricta; el rastro embebido sigue siendo consultable siempre.

## Ejemplo

```bash
curl http://127.0.0.1:4000/api/audit/verify
curl "http://127.0.0.1:4000/api/audit?eventType=signature_failed"
curl http://127.0.0.1:4000/api/audit/<id-de-la-accion>
```
