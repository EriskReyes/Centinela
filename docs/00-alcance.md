# Fase 0 — Alcance y nombre del proyecto

## Nombre: **Centinela**

## Pitch de una frase

> Centinela decide si un agente de IA puede tocar el dinero o los datos de tu empresa — y cuando la acción importa, exige la firma física de un humano antes de que pase nada.

## La historia del portafolio

Una PYME instala agentes de IA que proponen acciones reales: pagar una factura, reservar un hotel, pedir un crédito, leer una base de datos. Centinela se interpone en cada una: aplica la política de la empresa, ejecuta lo rutinario, frena lo importante para una firma WebAuthn y bloquea lo prohibido. Cada decisión queda auditada.

Es la misma historia que la del anillo físico —el humano *aprueba con su cuerpo* lo que la IA propone—, pero sin comprar hardware.

## Alcance realista: qué se construye

- **El anillo se simula** con cualquier autenticador WebAuthn real: huella del móvil, Windows Hello, llave USB. La arquitectura es idéntica; solo cambia el aparato físico.
- **La ejecución real de pagos se simula con conectores**: un módulo que "ejecuta" y registra el resultado. Integrar un banco real no aporta nada a un portafolio.
- Una empresa (sin multi-tenant), una moneda por acción, personas con una o varias llaves WebAuthn.

## Qué NO entra en el alcance

- Integración bancaria o de proveedores real.
- Multi-tenant y RBAC completo.
- Recuperación de credenciales WebAuthn perdidas (se resuelve registrando varias llaves por persona).
- Alta disponibilidad o despliegue multi-región.

## Decisiones técnicas (y por qué)

| Decisión | Motivo |
|---|---|
| TypeScript + Node + Express | Stack pedido y estándar de portafolio |
| MongoDB + Mongoose | Modelo documental: el rastro de decisiones encaja de forma natural |
| SimpleWebAuthn | Biblioteca de referencia para WebAuthn en Node |
| Zod | Validación en el borde de la API; el motor recibe datos ya validados pero no confía en ellos |
| `node:test` (nativo de Node ≥ 23.6) | Cero dependencias de pruebas; Node ejecuta TypeScript nativamente y el corredor trabaja en proceso (sin procesos hijo con pipes, bloqueados en este entorno) |
| Lógica pura separada de la API | El motor de reglas se prueba aislado desde el día uno |

## Arquitectura

```
Agente de IA
    │ propone una acción
    ▼
API Centinela (Express)
    │ valida (Zod) → guarda la propuesta en MongoDB → registra en auditoría
    ▼
Motor de reglas (lógica pura, sin IO)
    ├─ allow ──────────► ejecuta (conector simulado) → aprobada
    ├─ sign ───────────► pendiente de firma → móvil/laptop (WebAuthn) → aprobada / rechazada
    └─ block ──────────► rechazada + motivo (también auditado)
```

Cada flecha escribe en el **registro de auditoría** (Fase 5): nada ocurre sin dejar rastro.
