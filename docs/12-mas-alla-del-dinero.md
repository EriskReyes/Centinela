# Fase 9 — Más allá del dinero: archivos y programa

> Centinela deja de ser solo un guardián de pagos: ahora los agentes también proponen **cambios de archivos** y **cambios en el programa**, con las mismas reglas de decisión, firma y auditoría. Implementación: [`src/domain/action.ts`](../src/domain/action.ts), [`src/domain/paths.ts`](../src/domain/paths.ts), [`src/rules/`](../src/rules/), [`src/execution/`](../src/execution/).

## Los tipos nuevos

| Tipo | Operaciones válidas | Ejemplo |
|---|---|---|
| `file_change` | `create`, `modify`, `delete` | `modify` sobre `repo:centinela/docs/guia.md` |
| `program_change` | `deploy`, `configure`, `rollback`, `restart` | `deploy` sobre `deploy:staging` |

Ambos usan **`operation`** en lugar de `amountMinor` y **no exigen moneda**. Una operación que no corresponde a su tipo (`deploy` sobre un archivo) se rechaza con 400.

## Se firma el contenido, no solo el nombre

Firmar "modificar `config.ts`" sin saber **qué** se escribe es firmar un cheque en blanco. Por eso las operaciones que cambian contenido (`create`, `modify`, `deploy`, `configure`, `rollback`) exigen **`contentHash`**: el SHA-256 (hex, 64 caracteres) del contenido exacto.

- El `contentHash` y la `operation` entran en el **reto de firma**: firmar "modify con contenido A" no vale para "modify con contenido B" ni para "delete".
- `/firmar` y el panel muestran la huella del contenido para compararla.
- El conector debe comprobar, antes de escribir, que lo que va a aplicar es lo firmado: `contentMatches(action, contenido)` (comparación en tiempo constante). Si no coincide, no se aplica.
- La clave de idempotencia derivada incluye `operation` y `contentHash`: un `delete` justo después de un `modify` del mismo archivo no se confunde con un reintento.

## Rutas: se normalizan antes de decidir

El destino de un `file_change` / `program_change` se canonicaliza al recibirlo: `\` → `/`, barras repetidas a una, se quitan los segmentos `.`. Después:

- Cualquier `..` → **bloqueado** (no se sale del directorio: `repo:centinela/docs/../.env` ya no pasa por "ruta de confianza").
- Caracteres de control → bloqueado.
- La lista de **prohibidos** se compara sin distinguir mayúsculas (`.ENV` también es `.env` en Windows); `*` vale en cualquier posición. Por defecto: `.env*`, `*/.env*`, `.ssh/*`, `*/.ssh/*`, `*id_rsa*`, `*/.git/*`, `/etc/*`, `C:/Windows/*`.
- La lista de **confianza** sí distingue mayúsculas (lo seguro tiene que ser exacto).

## Las reglas por defecto

**Archivos** (`file_change`):
- Ruta de confianza (`repo:centinela/docs/*`, `backups:diarios/*`) con `create`/`modify` → se ejecuta sin firma.
- **`delete` exige firma siempre** (`signOperations: ['delete']`), aunque la ruta sea de confianza.
- Ruta nueva → pendiente de firma (una persona autorizadora).
- Ruta peligrosa → bloqueada siempre.

**Programa** (`program_change`):
- **Todas las operaciones exigen dos firmas de autorizadores** (`signOperations` las incluye todas, `quorumSignatures: 2`) — aunque el destino esté en la lista de confianza.
- `deploy:produccion` está prohibido por patrón en la política de la demo.

`signOperations` es un campo nuevo de la política por tipo: lista las operaciones que **siempre** pasan por una persona.

## Lo firmado se ejecuta

Cuando la última firma completa el quórum, Centinela llama al conector en ese momento y responde con `execution`. Antes, la acción quedaba "aprobada" sin hacerse. El orden es siempre: **guardar la acción aprobada → ejecutar → guardar el resultado**. Si el conector falla o lanza, la acción queda aprobada con una ejecución fallida visible en el historial; nunca hay una ejecución sin rastro. Una acción no se ejecuta dos veces.

Los conectores de la demo son simulados (`simulador-archivos`, `simulador-programa`). Un conector real aplicaría la operación con permisos mínimos y comprobaría `contentMatches` antes de escribir.

## Actualizar no regala permisos

Una política guardada por una versión anterior (sin `file_change` ni `program_change`) se lee con esos tipos **deshabilitados** (`{ allowed: false }`). Actualizar el servidor no hace que un agente empiece a borrar archivos: el admin los habilita en el panel. Los patrones de rutas prohibidas nuevos tampoco se añaden solos a una política existente: revísalos al habilitar los tipos.

## Modo estricto (el botón rojo del panel)

"**Modo estricto: todo requiere firma**" pide confirmación y, al aceptar, pone a cero los límites automáticos, **vacía la lista de destinos de confianza** y exige firma para todo destino fuera de ella. Resultado: ninguna acción (dinero, archivos, programa) se ejecuta sin una persona. Es una política nueva, versionada y auditada como cualquier otra.

## Probar

```bash
pnpm dev
HASH=$(printf 'contenido nuevo de la guía' | sha256sum | cut -d' ' -f1)
curl -X POST http://127.0.0.1:4000/api/actions \
  -H "Authorization: Bearer $AGENTE_TOKEN" -H "Content-Type: application/json" \
  -d "{\"actionType\":\"file_change\",\"destination\":\"repo:centinela/docs/guia.md\",\"operation\":\"modify\",\"contentHash\":\"$HASH\",\"justification\":\"Actualizar la guía con los límites nuevos\"}"
# → 201: ruta de confianza, ejecutada sin firma

curl -X POST http://127.0.0.1:4000/api/actions \
  -H "Authorization: Bearer $AGENTE_TOKEN" -H "Content-Type: application/json" \
  -d '{"actionType":"file_change","destination":"repo:centinela/docs/../.env","operation":"delete","justification":"Limpieza"}'
# → 403: la ruta contiene '..'
```
