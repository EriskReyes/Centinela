# Centinela 🛡️

**Pitch:** Centinela es el guardián entre los agentes de IA de una empresa y su dinero — decide si una acción se ejecuta sola, exige la firma física de un humano, o la bloquea, y deja constancia de absolutamente todo.

## La historia

Una empresa pone un agente de IA (asistente de compras, agente de reservas, analista de datos) a proponer acciones sobre su dinero, sus datos, sus **archivos** y su **programa**. Centinela se interpone en cada una:

1. **Motor de reglas** — la política de la empresa (importes, tipos, destinos, quórum) decide `allow`, `sign` o `block` sobre pagos, reservas, créditos, datos, cambios de archivos y cambios en el programa.
2. **Firma física con WebAuthn** — huella del móvil, Windows Hello o llave USB. El reto firmado es el hash de los datos exactos de la acción; lo importante exige **dos firmas de personas distintas con rol autorizador** (cuarto ojos), cada una precedida de un código de verificación de 16 hex que se teclea y se compara con otro dispositivo.
3. **Registro de auditoría** — cada propuesta, decisión, firma y revocación queda guardada en una cadena de hashes; su cabeza se **ancla fuera de la base de datos** periódicamente, con detección de fallos y de "silencio".

Y la separación que lo sostiene todo: **el agente no tiene llaves de admin** (Fase 8). Propone con su token y solo puede eso; política, llaves y firma son de otra identidad.

## Arquitectura

```
Agente de IA (con su token)
    │ POST /api/actions (acción propuesta)
    ▼
API Centinela (Express · TypeScript · Node ≥ 22.6)
    │ control de acceso (agente vs admin) → valida (Zod) → idempotencia → motor (lógica pura)
    ├─ allow ─────────► conector simulado ejecuta ──────────► aprobada (201)
    ├─ sign ──────────► pendiente (1 o 2 firmas de autorizadores, según quórum)
    │                    ▲ panel muestra códigos de verificación
    │                    │ móvil/laptop /firmar: teclea el código + huella/PIN
    │                    └─ aprobada con quórum / rechazada con veto
    └─ block ─────────► rechazada con motivo, también auditada (403)
                          │
    MongoDB (acciones, política versionada, llaves con rol, retos)  ·  registro encadenado
                          │                                                │
                          └──── ancla periódica (éxitos y fallos) ────────► anchors.log + webhook
                                                    y alerta si la copia externa calla demasiado
```

## Probar en 3 pasos

```bash
pnpm install
pnpm dev                       # http://localhost:4000 (Mongo local)
# panel (libro mayor): localhost:4000/panel · firma: localhost:4000/firmar
pnpm test                      # 260 pruebas, incluida la integración con Mongo
```

Al arrancar sin `CENTINELA_ADMIN_TOKEN` / `CENTINELA_AGENT_TOKENS`, el servidor imprime unos tokens válidos solo para esa ejecución: el panel y `/firmar` piden el de admin.

Demos sin navegador (exporta `CENTINELA_AGENT_TOKEN` y `CENTINELA_ADMIN_TOKEN`): `pnpm demo:agent` (un agente propone pagos) y `pnpm demo:webauthn` (firma completa con criptografía real).

## Límites honestos

- **El agente no tiene llaves de admin**: solo propone acciones y consulta las suyas; política, llaves y firma exigen otro token. Si el agente puede leer el `.env` del servidor, esa separación desaparece: ver [`docs/11-acceso.md`](docs/11-acceso.md).
- **Preguntas frecuentes de seguridad** — los cuatro escenarios del ensayo oral, con dónde termina cada defensa: [`docs/10-seguridad-faq.md`](docs/10-seguridad-faq.md).
- Sin `Idempotency-Key`, la API deriva una del payload + una ventana de tiempo (red de seguridad): los reintentos dentro de la ventana no duplican pagos. Un reintento **fuera** de la ventana sí crea otra acción: para control total, el agente manda su clave explícita (ver [`docs/03-api.md`](docs/03-api.md)).
- El cuarto ojos exige **personas distintas con rol autorizado**: dos cuentas de bajo nivel comprometidas no pueden firmarse entre ellas. Pero WebAuthn prueba **posesión de la llave, no la identidad**: dos cuentas de la misma persona contarían como dos personas — en producción la identidad debe salir de un IdP, no del formulario de registro (ver la pregunta 3 de la FAQ).
- Los cambios de archivos y de programa usan **conectores simulados**: la decisión y la auditoría son reales, la ejecución no toca el sistema de archivos (ver [`docs/12-mas-alla-del-dinero.md`](docs/12-mas-alla-del-dinero.md)).
- La cadena de hashes detecta alteraciones y el anclaje detecta borrados, pero un atacante con root en el host puede tocar también el archivo de anclas: por eso la copia fuerte es el webhook externo. Los fallos de anclaje quedan auditados (evento `anchor_failed` + diario externo) y el panel **alerta del silencio prolongado** de la copia externa.
- Una pantalla de firma comprometida puede mentir: se mitiga con el código tecleado entre dos canales ([`docs/08`](docs/08-canal-cruzado.md)); la producción real separaría el servicio de firma.
- Detalle completo en [`docs/07-ataques.md`](docs/07-ataques.md) y [`docs/09-produccion.md`](docs/09-produccion.md).

## Alcance (Fase 0)

El "anillo" se simula con **cualquier autenticador WebAuthn real** que ya tengas (tu móvil o tu laptop). La arquitectura es idéntica a la de un anillo hardware: solo cambia el aparato físico. Detalles en [`docs/00-alcance.md`](docs/00-alcance.md).

## Fases

- [x] **Fase 0 — Alcance y nombre** → [`docs/00-alcance.md`](docs/00-alcance.md)
- [x] **Fase 1 — Modelo de datos** → [`docs/01-modelo-de-datos.md`](docs/01-modelo-de-datos.md), [`src/domain/`](src/domain/)
- [x] **Fase 2 — Motor de reglas** → [`src/rules/`](src/rules/) (lógica pura, con pruebas)
- [x] **Fase 3 — API Express + MongoDB** → [`docs/03-api.md`](docs/03-api.md), [`src/api/`](src/api/)
- [x] **Fase 4 — Firma WebAuthn** (SimpleWebAuthn) → [`docs/04-webauthn.md`](docs/04-webauthn.md), [`src/auth/`](src/auth/), página [`/firmar`](src/auth/firmar.html)
- [x] **Fase 5 — Registro de auditoría** → [`docs/05-auditoria.md`](docs/05-auditoria.md), [`src/audit/`](src/audit/) (append-only, cadena de hashes, verificación de integridad)
- [x] **Fase 6 — Panel de administración** → [`docs/06-panel.md`](docs/06-panel.md), [`src/web/panel.html`](src/web/panel.html) (pendientes, historial, reglas editables en `/panel`)
- [x] **Fase 7 — Pruebas de ataque** → [`docs/07-ataques.md`](docs/07-ataques.md), [`src/security/attacks.test.ts`](src/security/attacks.test.ts) (red team ejecutable: cada vector es un test)
- [x] **Canal cruzado (dispositivo infectado)** → [`docs/08-canal-cruzado.md`](docs/08-canal-cruzado.md) (código tecleado entre panel y pantalla de firma, despliegue en dos dispositivos)
- [x] **Cuarto ojos con roles** — dos firmas de personas distintas por umbral, reto ligado al progreso y roles de autorización (un empleado no cubre firmas de autorizadores)
- [x] **Idempotencia en dos capas** — clave explícita + clave derivada con ventana configurable (red de seguridad contra reintentos)
- [x] **Anclaje externo de la auditoría** — cabeza de la cadena publicada a archivo + webhook, con fallos auditados y alerta de silencio
- [x] **Revocación de llaves y entornos** → [`docs/09-produccion.md`](docs/09-produccion.md), [`.env.example`](.env.example)
- [x] **FAQ de seguridad** → [`docs/10-seguridad-faq.md`](docs/10-seguridad-faq.md) (los límites explicados, para entrevistas)
- [x] **Fase 8 — El agente contra el guardián** → [`docs/11-acceso.md`](docs/11-acceso.md), [`src/api/access.ts`](src/api/access.ts) (tokens separados de agente y admin, tope acumulado anti-fraccionamiento)
- [x] **Fase 9 — Más allá del dinero** → [`docs/12-mas-alla-del-dinero.md`](docs/12-mas-alla-del-dinero.md) (archivos con rutas protegidas, cambios de programa con doble quórum de autorizadores, modo estricto en el panel)

## Stack

TypeScript · Node.js (≥ 22.6; ejecuta TypeScript de forma nativa — probado en 22.23.4 y 24.21.0) · Express · MongoDB (Mongoose) · SimpleWebAuthn · Zod · `node:test`

## Estructura

```
centinela/
├── docs/                  # decisiones de diseño por fase + FAQ de seguridad
│   ├── 00-alcance.md      01-modelo-de-datos.md
│   ├── 03-api.md          04-webauthn.md          05-auditoria.md
│   ├── 06-panel.md        07-ataques.md           08-canal-cruzado.md
│   ├── 09-produccion.md   10-seguridad-faq.md     11-acceso.md
│   └── 12-mas-alla-del-dinero.md
├── src/
│   ├── domain/            # Fase 1: la acción, sus estados y su validación
│   ├── rules/             # Fase 2: política (quórum, roles, topes) + motor
│   ├── api/               # Fases 3+8: Express, repositorios, idempotencia, acceso
│   ├── db/                # Fase 3: modelos Mongoose y mapeos dominio↔Mongo
│   ├── execution/         # Fase 3: conectores de ejecución simulados
│   ├── auth/              # Fase 4: WebAuthn (servicio, rutas, retos, testkit)
│   ├── audit/             # Fase 5: cadena de hashes + anclaje externo
│   ├── security/          # Fase 7: suite de ataques (red team)
│   └── web/               # Fase 6: panel de administración (/panel)
├── scripts/
│   ├── smoke.mjs          # cliente de demo: un agente de IA contra la API
│   └── webauthn-demo.ts   # demo de firma con autenticador virtual
├── .env.example           # variables documentadas (dev vs producción)
└── anchors.log            # diario externo de anclas (gitignored; respaldar aparte)
```

## Cómo probar

```bash
pnpm install
pnpm test        # 260 pruebas: modelo, motor, API, acceso, WebAuthn, cuarto ojos con roles, archivos y programa, auditoría, anclaje y red team
pnpm typecheck   # TypeScript estricto
```

## Arrancar y usar

```bash
pnpm dev                       # http://localhost:4000 con MongoDB local
CENTINELA_STORE=mock pnpm dev  # demo sin base de datos (en memoria)
```

- **Cliente de demo** (un agente de IA): `pnpm demo:agent`
- **Panel de administración**: <http://localhost:4000/panel> — pendientes con firmas y códigos de verificación, historial con doble rastro, reglas editables (límites, quórum, roles, rutas de archivos) sin tocar código, llaves revocables, estado del anclaje externo y el botón **"Modo estricto: todo requiere firma"**.
- **Firma con tu llave**: abre <http://localhost:4000/firmar> (con `localhost`, no 127.0.0.1), registra tu huella/Windows Hello con un rol y aprueba o rechaza. Antes de firmar, la página exige **teclear un código de verificación de 16 caracteres hex (64 bits)** que debe coincidir con el del panel en otro dispositivo.
- **Firma desde el móvil (dos dispositivos)**: `HOST=0.0.0.0` + túnel HTTPS + `RP_ID`/`ORIGIN` — guía en [`docs/08-canal-cruzado.md`](docs/08-canal-cruzado.md).
- **Demo de firma sin navegador** (autenticador virtual, criptografía real): `pnpm demo:webauthn`
- **Auditoría** (con el token de admin): `curl -H "Authorization: Bearer $CENTINELA_ADMIN_TOKEN" http://127.0.0.1:4000/api/audit/verify` comprueba la cadena completa; `/api/audit/anchor` muestra el último anclaje externo y si la copia está callando.

Ejemplos con curl en [`docs/03-api.md`](docs/03-api.md) y [`docs/12-mas-alla-del-dinero.md`](docs/12-mas-alla-del-dinero.md).

## Decisiones de diseño (resumen)

- **Dinero en unidades menores (centavos)**: `1234_56` = 1.234,56 EUR. Sin coma flotante.
- **El motor es lógica pura** (sin red, sin base de datos): se prueba aislado desde el día uno.
- **Inmutabilidad**: cada decisión produce una acción *nueva* con su `DecisionRecord` añadido; el histórico nunca se reescribe.
- **Defensa en profundidad**: el motor vuelve a validar lo que el borde ya validó, porque un sistema de seguridad no confía en su propia entrada.
- **Idempotencia en dos capas**: la clave explícita del agente manda; sin ella, una derivada del payload + ventana evita duplicados accidentales.
- **Quórum con roles**: la política decide cuántas firmas y de qué roles; la exigencia se fotografía en la acción en el momento de decidir.
- **El agente y el admin nunca se mezclan**: tokens distintos, rutas distintas, y toda ruta nueva nace protegida (fail-closed).
- **El anclaje vive fuera de Mongo**: su diario registra éxitos y fallos, y la alerta de silencio se compara contra ese diario externo — no contra eventos borrables de la cadena.
- **Sin transpilador para probar**: Node ≥ 22.6 ejecuta TypeScript de forma nativa (con `--experimental-strip-types`); las pruebas corren con `node --test` (cero dependencias de pruebas).
- **`node_modules` plano** (`node-linker=hoisted` en [`pnpm-workspace.yaml`](pnpm-workspace.yaml)): en Windows sin permisos de symlink se evitan enlaces rotos.

## Licencia

[MIT](LICENSE) © 2026 Rigo Erisk Reyes. Puedes usar, copiar, modificar y distribuir este código libremente, manteniendo el aviso de copyright y la licencia.
