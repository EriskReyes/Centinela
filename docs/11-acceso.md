# Fase 8 — El agente contra el guardián

> Implementación: [`src/api/access.ts`](../src/api/access.ts), [`src/api/app.ts`](../src/api/app.ts), [`src/rules/engine.ts`](../src/rules/engine.ts). Pruebas: [`src/security/attacks.test.ts`](../src/security/attacks.test.ts) (bloques "Fase 8"), [`src/api/access.test.ts`](../src/api/access.test.ts).

La firma WebAuthn es criptográficamente sólida, pero solo protege si el agente **no puede tocar nada más**. Hasta la Fase 7, la API no pedía credenciales: el mismo agente que proponía un pago podía, con la misma API, saltarse la llave de cuatro maneras:

| Ataque del agente | Antes | Ahora |
|---|---|---|
| `PUT /api/policy` subiendo `allowLimitMinor` a un millón → el pago sale como `allow` | posible | **403** + evento `access_denied` |
| Registrar su propia llave (autenticador por software) con rol `autorizador` y firmarse | posible | **403** |
| Revocar las llaves de los humanos (`DELETE /api/webauthn/credentials/:id`) | posible | **403** |
| 20 pagos de 25 € a un destino de confianza (cada uno bajo el límite de 100 €) | 500 € sin firma | **tope acumulado**: 300 €/día, el resto pide firma |

## Dos identidades

| | Token | Puede |
|---|---|---|
| **Agente** | `CENTINELA_AGENT_TOKENS` (`agentId=token`, uno por agente) | `POST /api/actions` y `GET /api/actions/:id` (solo las suyas) |
| **Admin** | `CENTINELA_ADMIN_TOKEN` | todo lo demás: política, llaves, cola, firma, auditoría, panel |

- `Authorization: Bearer <token>`; comparación en tiempo constante.
- **Fail-closed**: todo `/api` es de admin salvo las dos rutas del agente. Una ruta nueva nace protegida.
- El token **fija el `agentId`**: proponer como otro agente → 403; ver acciones ajenas → 404; reutilizar la clave de idempotencia de otro agente → 409.
- El admin no propone acciones: si el token del panel se filtra, no se convierte en un agente sin límites.
- Al arrancar se rechazan tokens de menos de 24 caracteres o repetidos entre identidades.
- Sin variables definidas, el servidor genera tokens **solo para esa ejecución** y los imprime (modo desarrollo). En producción, defínelos en `.env`.
- El panel y `/firmar` piden el token de admin una vez y lo guardan en `sessionStorage` (solo esa pestaña).

```bash
# El agente propone (su token)
curl -X POST http://127.0.0.1:4000/api/actions \
  -H "Authorization: Bearer $CENTINELA_AGENT_TOKEN" -H "content-type: application/json" \
  -d '{"actionType":"payment","amountMinor":2500,"currency":"EUR","destination":"amazon.es","justification":"Material de oficina del mes"}'

# El agente intenta cambiar la política → 403 (y queda auditado)
curl -X PUT http://127.0.0.1:4000/api/policy -H "Authorization: Bearer $CENTINELA_AGENT_TOKEN" -d '{}'
```

## Tope acumulado (anti-fraccionamiento)

Por tipo de acción, en la política:

```ts
payment: {
  allowLimitMinor: 100_00,            // cada pago, sin firma, hasta 100 €
  cumulativeAllowLimitMinor: 300_00,  // pero la suma sin firma no pasa de 300 €…
  cumulativeWindowMinutes: 24 * 60,   // …en 24 h, por agente
}
```

- Cuenta lo que el motor dejó pasar **sin firma** (`allow`) para ese agente, tipo y moneda dentro de la ventana. Lo firmado por un humano no consume el tope.
- Si el acumulado + el importe nuevo lo supera → `sign` con el motivo explicado.
- El motor sigue siendo puro: la API calcula el acumulado (`sumAutoApproved` en el repositorio) y se lo pasa como contexto.
- La lectura del acumulado y la inserción van en una sección crítica por agente: 20 envíos en paralelo no ven todos el mismo total (hay un test para eso).

## Límites honestos

- **El token de admin debe vivir fuera del alcance del agente.** Si el agente corre en la misma máquina y puede leer el `.env` del servidor, ningún control de la API lo detiene. Sepáralos (otro usuario del sistema, otro contenedor o un gestor de secretos).
- Quien tiene el token de admin puede registrar llaves con cualquier rol: el admin es de confianza. Lo siguiente sería que dar de alta una llave nueva exija la firma de una llave existente.
- La sección crítica es **por proceso**. Con varias instancias detrás de un balanceador, haría falta un bloqueo compartido (por ejemplo, un documento por agente en Mongo con `findOneAndUpdate`).
- El tope se cuenta **por moneda**: un agente con EUR, USD y CHF habilitados tiene tres topes. Si eso importa, limita las monedas por tipo en la política.
- Los tokens son estáticos y sin caducidad: en producción, rótalos o usa un IdP (OAuth client credentials para agentes, SSO para el panel).
