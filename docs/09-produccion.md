# Producción y separación de entornos

> Guía corta para pasar de la demo a un despliegue creíble. El ejemplo completo de variables está en [`.env.example`](../.env.example).

## Desarrollo vs producción: qué cambia de verdad

| Variable | Desarrollo (esta máquina) | Producción / dos dispositivos |
|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` (detrás de HTTPS/proxy) |
| `RP_ID` | `localhost` | dominio registrable (ej. `firmas.empresa.com`) |
| `ORIGIN` | `http://localhost:4000` | `https://<dominio>` (contexto seguro obligatorio) |
| `MONGO_URL` | tu mongod local | instancia gestionada, con copias y red privada |
| `CENTINELA_STORE` | `mongo` (o `mock` solo para demos) | siempre `mongo` |
| `ANCHOR_FILE` | `anchors.log` local | volumen persistente SEPARADO del host de Mongo |
| `ANCHOR_WEBHOOK_URL` | (ausente) | obligatorio: copia externa de las anclas |
| `PORT` | 4000 | el que diga tu proxy |

Regla de oro: **el `.env` de producción nunca se parece al de desarrollo** — RP_ID/ORIGIN distintos, Mongo distinto, anclaje externo activo. Si una demo arranca con el RP_ID de producción, algo está mal en la configuración.

## Llaves perdidas y suplentes

- **Revocación**: el panel (`/panel` → "Llaves y personas") revoca una llave al instante (`DELETE /api/webauthn/credentials/:id`); el evento queda auditado y la llave deja de verificar en la siguiente firma.
- **Suplentes para el cuarto ojos**: el quórum exige *personas distintas*, no personas concretas — registrar la llave de un suplente (otro `userId`) lo habilita para firmar. Para reglas tipo "María O su suplente", haría falta una política de delegación con vencimiento: queda documentado como extensión, no implementado.
- **Mínimo operativo**: al menos dos personas con llave registrada por empresa; si solo hay una y se pierde, hay que resetear el RP por completo (re-registrar todas las llaves).

## Despliegue mínimo creíble

1. El API y Mongo en un host; el panel y `/firmar` servidos por el mismo proceso (demo) o — mejor — la pantalla de firma como servicio separado con superficie mínima.
2. HTTPS con certificado real (WebAuthn no funciona sin contexto seguro fuera de localhost).
3. `ANCHOR_WEBHOOK_URL` apuntando a un sistema ajeno (tu correo/ops), y el archivo de anclas respaldado fuera del host de Mongo.
4. Copias de seguridad de Mongo con prueba de restauración periódica.

## Qué NO está resuelto (honesto)

- Delegación de firma con vencimiento (suplentes formales).
- Multi-tenant e identidad federada (hoy: tokens estáticos de agente y de admin, ver [`docs/11-acceso.md`](11-acceso.md)).
- Bloqueo compartido del tope acumulado entre varias instancias (hoy la sección crítica es por proceso).
- Alta disponibilidad y transacciones multi-documento para la doble escritura acción+auditoría (ver [`docs/05-auditoria.md`](05-auditoria.md)).
- Ver detalle completo en [`docs/07-ataques.md`](07-ataques.md) y [`docs/08-canal-cruzado.md`](08-canal-cruzado.md).
