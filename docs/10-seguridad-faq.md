# Preguntas frecuentes de seguridad

> Cuatro escenarios ensayados en voz alta, en mis propias palabras. No son una lista de features: son las preguntas que un entrevistador técnico haría, respondidas **nombrando dónde termina cada defensa**. Si quieres el detalle ejecutable de cada una, está en [`07-ataques.md`](07-ataques.md); aquí está el porqué.

## 1 · Entrada maliciosa: un JSON con importe negativo, moneda inventada y un intento de contaminar el prototipo

**¿Qué le pasa a esta petición?**

Muere en el borde, en cuatro capas, sin tocar nunca la base de datos.

- `JSON.parse` no recorre la cadena de prototipos: el `__proto__` llega como una clave de datos normal, no como manipulación real del objeto. `Object.prototype` queda intacto.
- El esquema Zod rechaza el importe negativo (exige entero positivo) y la justificación de dos caracteres (mínimo diez). La moneda inventada pasa la validación de *formato* —tres mayúsculas—, y ahí está la lección: **el formato lo valida el borde; la semántica, el motor**. La lista blanca de la política (EUR/USD/CHF) la habría bloqueado en la siguiente capa.
- Zod **elimina** las claves que no conoce: el `__proto__` se descarta, y aunque manden `status: 'approved'` o un `id` propio, los asigna el servidor y el cliente no puede pisarlos.
- Resultado: 400 con los issues exactos. La acción nunca se crea, así que no hay nada guardado ni auditado: cero efectos secundarios.

Y por si alguien se saltara el borde con una acción forjada en memoria, el motor re-valida tipo, importe y estado. Ninguna capa sola basta; juntas, sí.

## 2 · Ataque a la firma: reutilizar una firma válida de ayer

**¿Puedo usar la firma de un pago de 200 € para aprobar uno de 9.000 € a mi cuenta?**

No, y el porqué es el corazón del diseño: **la firma WebAuthn no es un token, es un compromiso criptográfico con unos bytes concretos**. El reto firmado es el hash de la acción original — id, tipo, importe, moneda, destino, justificación, decisión y firmas previas. La aserción de ayer lleva dentro el challenge de ayer; contra el pago nuevo, el servidor espera otro hash. El intento muere en el instante exacto en que `verifyAuthenticationResponse` compara los challenges: 400, el fallo queda auditado, y de paso se consume el reto legítimo de la acción nueva. Aunque el challenge coincidiera por milagro, queda el contador anti-replay: la aserción vieja trae un contador viejo.

**¿Y si reenvío la firma original contra la acción original, para ejecutarla dos veces?**

Falla en tres capas, ordenadas de más barata a más cara a propósito: primero la máquina de estados — la acción ya está aprobada, 409 antes de tocar criptografía. Segundo, el reto era de un solo uso y se consumió ayer. Tercero, el contador de la credencial rechazaría la aserción antigua. Y la doble ejecución ni siquiera es alcanzable: el conector corre una sola vez, en la rama `allow`, al proponerse la acción; aprobar por firma no dispara ejecución por ningún endpoint.

## 3 · Colusión en el cuarto ojos

**¿Qué pasa si firmo con dos cuentas mías, una con un `userId` ligeramente distinto?**

Hoy, eso **se cuela** — y prefiero decirlo sin inflar lo construido. La defensa compara `keyId` y `userId` como strings; dos cuentas de la misma persona son indistinguibles de dos personas. La razón es estructural: **WebAuthn demuestra posesión de una llave, no la identidad de quien la maneja**, y en la demo el `userId` lo declara quien se registra. El cierre no es código en el motor: es que la identidad salga de un directorio verificado (IdP de RRHH, SSO) y las credenciales se vinculen a esa identidad. El cuarto ojos responde dos preguntas distintas — *"¿quién puede firmar?"* (roles: cerrado) y *"¿quién ES el que firma?"* (identidad: abierto en la demo). Mezclarlas es el error clásico.

**¿Y si convenzo a un compañero con rol 'empleado' de firmar de buena fe, sin saber el importe?**

Ahí sí está cerrado: la política exige rol `autorizador` en **todas** las firmas del quórum, y esa exigencia quedó fotografiada en la acción al decidirla. La llave del empleado se rechaza con 403 antes de contar nada; su firma no suma ni deja progreso. Y aunque firme sin leer, su firma queda ligada al hash de los datos exactos: el sistema no puede ser engañado sobre *qué* se firmó, aunque el humano no lea. Para eso existen el importe en pantalla y el código tecleado entre dos canales.

## 4 · Integridad bajo compromiso total: root en el host y admin de Mongo

**¿Qué puedo ocultar con ese nivel de acceso?**

Casi todo, y hay que decirlo sin rodeos: **todo lo que vive en esa máquina me obedece**. Puedo insertar la acción fraudulenta con su aprobación impecable; borrar la cadena y reescribirla con hashes recalculados (son deterministas, y `verify()` dará OK sobre mi cadena falsa); reescribir el archivo de anclas, que está en el host; borrar los `anchor_failed`; incluso fabricarme una credencial con mi propia clave — genero el par, escribo el registro, y la criptografía me dará la razón. Todo lo que consulta esa máquina, panel incluido, dirá que estoy sano.

Lo que **no** puedo reescribir son los hechos que ya salieron de mi alcance: los anclajes que el webhook entregó al sistema externo *antes* del ataque, cada uno con su hash y su recuento. Mi cadena reescrita no puede hacer coincidir sus cabezas con esos hashes ya entregados, y no puedo des-enviar lo enviado. Ahí termina la defensa automática. El resto es humano: alguien del lado externo compara su historia de anclas contra la cadena y ve el descuadre, o nota que Centinela dejó de mandar anclas a las 03:12. Si el receptor externo también es mío, no queda nada automático.

**¿El anclaje con detección de silencio es seguridad?**

No, en sentido estricto: no previene nada, no reduce ni una capacidad del atacante. Es **tamper-evidence**: el precinto de una caja no detiene al ladrón, le dice a la víctima que la caja fue abierta. Su valor solo se realiza dentro de un proceso — alguien compara, alguien escucha el silencio, alguien investiga. Convierte "fraude silencioso para siempre" en "fraude que además debe comprometer el receptor externo o sobrevivir a la comparación".

## 5 · ¿Puede el agente saltarse la firma?

**Con su token de agente, ¿puede aprobar su propio pago, registrar una llave o cambiar la política?**

No. El token de agente solo abre `POST /api/actions` y `GET /api/actions/:id` (de sus propias acciones). Todo lo demás de `/api` es de admin por defecto: firmar, registrar llaves, política, cola y auditoría responden 403 y el intento queda auditado como `access_denied`.

**¿Y troceando un pago grande en muchos pequeños, o disfrazando un borrado?**

Los pagos pequeños suman contra un tope diario por agente; pasado el tope, piden firma (también si llegan en paralelo). Un `delete` o un `deploy` exigen firma por su operación, aunque la ruta sea de confianza; una ruta con `..` se bloquea; y lo que se firma incluye el hash del contenido, así que no se puede firmar un cambio y aplicar otro.

**¿Dónde termina?** Si el agente roba el token de admin, o una persona con llave firma sin leer, la defensa es el registro de auditoría, no la prevención.

---

**La regla que resume las cuatro respuestas:** di siempre dónde termina la defensa. Un sistema de seguridad honesto no promete protegerlo todo; promete que cada capa falle de forma ruidosa, barata y auditable — y que se sepa exactamente en qué punto deja de ser automático y empieza a depender de una persona.
