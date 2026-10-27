/**
 * Cliente de demo: simula a un agente de IA proponiendo acciones al guardián.
 * Uso: arranca el servidor (pnpm dev) y ejecuta `node scripts/smoke.mjs`.
 */
const BASE = process.env.CENTINELA_URL ?? 'http://127.0.0.1:4000';
// Fase 8: el agente propone con SU token; la cola y la política son del admin.
const AGENT_TOKEN = process.env.CENTINELA_AGENT_TOKEN;
const ADMIN_TOKEN = process.env.CENTINELA_ADMIN_TOKEN;
if (AGENT_TOKEN === undefined || ADMIN_TOKEN === undefined) {
  console.error('Define CENTINELA_AGENT_TOKEN y CENTINELA_ADMIN_TOKEN (los imprime el servidor al arrancar).');
  process.exit(1);
}

async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/api/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  return { status: res.status, body: await res.json() };
}

const pay = (over = {}) => ({
  agentId: 'agente-compras',
  actionType: 'payment',
  amountMinor: 2500,
  currency: 'EUR',
  destination: 'amazon.es',
  justification: 'Compra de material de oficina aprobada en presupuesto mensual',
  ...over,
});

const resultados = [];
function reportar(titulo, res) {
  const { status, body } = res;
  const resumen =
    body?.decision !== undefined
      ? `${status} → decisión: ${body.decision} · estado: ${body.action?.status}`
      : `${status} · ${body?.error ?? body?.ok ?? ''}`;
  resultados.push(`${titulo}: ${resumen}`);
}

// 1. Un pago pequeño: se permite y ejecuta.
const allow = await post(pay());
reportar('Pago pequeño (allow)', allow);

// 2. Un pago grande: queda pendiente de firma.
const sign = await post(pay({ amountMinor: 50000, justification: 'Renovación anual de licencias del equipo' }));
reportar('Pago grande (sign)', sign);

// 3. Un destino prohibido: bloqueado, pero también guardado.
const block = await post(
  pay({ destination: 'crypto:binance', justification: 'Mover fondos a un exchange de cripto' }),
);
reportar('Destino prohibido (block)', block);

// 4. Entrada inválida: 400 con los issues de validación.
const invalid = await post(pay({ currency: 'eur' }));
reportar('Moneda inválida (400)', invalid);

// 5. Idempotencia: el agente reintenta con la misma clave y no se duplica nada.
await post(pay({ amountMinor: 7777, justification: 'Suscripción mensual al SaaS de contabilidad' }), {
  'Idempotency-Key': 'demo-clave-1',
});
const replay = await post(pay({ amountMinor: 7777, justification: 'Suscripción mensual al SaaS de contabilidad' }), {
  'Idempotency-Key': 'demo-clave-1',
});
reportar('Reintento idempotente (replay)', replay);

// 6. La cola que consultará el móvil en la Fase 4.
const pending = await get('/api/actions/pending');
resultados.push(`Cola de pendientes: ${pending.body.count} solicitud(es) esperando firma`);

// 7. La política vigente.
const policy = await get('/api/policy');
resultados.push(`Política vigente: ${policy.body.policy?.id} v${policy.body.policy?.version}`);

console.log(resultados.join('\n'));
