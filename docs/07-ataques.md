# Fase 7 — Pruebas de ataque

> Suite ejecutable: [`src/security/attacks.test.ts`](../src/security/attacks.test.ts). Cada test es un intento real de romper el sistema por la API pública: si la suite pasa, la defensa aguanta.

## El resultado en una tabla

| Ataque | Resultado | Defensa |
|---|---|---|
| Tipo de acción inexistente | 400 en el borde (y el motor lo rebloquearía si se forzara) | Zod + defensa en profundidad |
| Importe negativo, cero o no numérico | 400 | Zod |
| Importe descomunal (10¹⁵) | 403, sin desbordar nada | Límites máximos de la política |
| Moneda no ISO 4217 | 400 | Zod |
| Justificación vacía o mínima | 400 | Zod |
| Payload gigante (> 100 kb) | 413 | Límite de `express.json` |
| Prototype pollution vía metadata | inofensivo; `Object.prototype` limpio | `JSON.parse` + esquema |
| Inyección noSQL en filtros | filtro ignorado, sin operadores | parser simple + campos tipados |
| El cliente se asigna estado "aprobado" | ignorado: el estado lo decide el MOTOR | Flujo del servidor |
| Campos desconocidos en el cuerpo | eliminados por el esquema | Zod (strip) |
| Misma `Idempotency-Key` dos veces | 1 acción; la segunda devuelve la original | Índice único sparse |
| Mismo payload **sin** clave (reintento en la ventana) | 1 acción; `replayed: true` | Clave derivada del payload + ventana |
| Doble envío **paralelo** con la misma clave | 1 acción | Índice único (ahora también en el almacén en memoria) |
| Firma de un **rol no autorizado** | 403; sin progreso de firmas | `requiredRoles` fotografiados en la acción |
| La misma llave o persona cubriendo dos firmas del quórum | 409 | `SignatureAlreadyPresentError` |
| **Reenviar una firma vieja** | 409 si ya se aplicó; 400 si el reto se consumió | Retos de un solo uso + máquina de estados |
| Un intento de firma fallido | consume el reto: ni la firma buena posterior vale | Consumo antes de verificar |
| Reto de una acción usado en otra | 400 | Reto ligado a (acción, decisión) |
| Llave no registrada | 400 | Repositorio de credenciales |
| Llave clonada firmando desde origen malicioso | 400 | Comprobación de origen |
| Llave clonada con rpID malicioso | 400 | `rpIdHash` |
| Firma manipulada byte a byte | 400 + `signature_failed` auditado | Verificación ECDSA |
| Firmar con decisión distinta a la del reto | 400 | El hash del reto incluye la decisión |
| Firmar una acción ya decidida | 409 | Máquina de estados |
| Firmar una solicitud expirada | 409 y pasa a `expired` | TTL + expiración al leer |
| Política con límites incoherentes | 400; la vigente queda intacta | `PolicySchema` superRefine |
| Política sin un tipo obligatorio | 400 | Esquema |
| Regresión de versión de política | el servidor asigna la siguiente | Versionado en servidor |
| `loan` / destino crypto / moneda GBP | 403 | Política |
| Reescribir un campo del registro | detectado: cadena rota en la entrada N | Cadena de hashes |
| Reescribir un hash del registro | detectado | `contentHash` verificado |
| Borrar una entrada | hueco de secuencia detectado | Secuencia monótona |

## Hallazgos reales durante la red team

1. **Carrera de idempotencia en el almacén en memoria** — *encontrado y corregido*. El repositorio en memoria no aplicaba el índice único de Mongo: dos envíos paralelos con la misma clave podían duplicar un pago en modo mock. Ahora replica el índice y hay un test de carrera.
2. **Firma "manipulada" que seguía siendo válida** — *bug en el testkit, corregido*. Voltear el último carácter de base64url no cambia los bytes decodificados cuando la longitud es 2 mod 4 (el último carácter solo aporta bits de padding): ~10% de las firmas "rotas" eran idénticas a la original y verificaban. La manipulación ahora rompe el primer carácter, siempre significativo, y la suite completa pasa tres veces seguidas.
3. **Reintento tardío sin clave explícita** — *limitación documentada*. La clave derivada usa una ventana (60 s por defecto): un reintento 61 segundos después crea una acción nueva. El cierre real es la `Idempotency-Key` explícita del agente; para dos acciones idénticas INTENCIONADAS, claves distintas.
4. **Los documentos de acción no están hasheados** — *limitación conocida*. La cadena protege el registro; el documento se contrasta con él por el doble rastro (estado antes/después y decisiones repetidas en ambos sitios). En producción, un hash por documento o firma del registro cerraría el hueco.

## Qué demuestra esta fase

Cada defensa vive en una capa concreta — borde → motor → estados → criptografía → registro — y cada ataque se prueba contra la API real. Los dos agujeros reales que encontramos se corrigieron y quedan documentados aquí: esto es entender el problema, no copiar un patrón.
