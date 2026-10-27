/**
 * Demo en vivo de la Fase 4: registra una llave virtual, propone un pago que
 * exige firma y lo firma de verdad contra el servidor corriendo.
 *
 * Uso:
 *   pnpm dev                       # en una terminal
 *   node scripts/webauthn-demo.ts  # en otra
 */
import { FakeAuthenticator } from '../src/auth/testkit.ts';

const BASE = process.env.CENTINELA_URL ?? 'http://localhost:4000';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:4000';
// Fase 8: el agente propone con SU token; registrar y firmar es cosa del admin.
const AGENT_TOKEN = process.env.CENTINELA_AGENT_TOKEN;
const ADMIN_TOKEN = process.env.CENTINELA_ADMIN_TOKEN;
if (AGENT_TOKEN === undefined || ADMIN_TOKEN === undefined) {
  console.error('Define CENTINELA_AGENT_TOKEN y CENTINELA_ADMIN_TOKEN (los imprime el servidor al arrancar).');
  process.exit(1);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const token = path === '/api/actions' ? AGENT_TOKEN : ADMIN_TOKEN;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// La "llave" del humano (en la vida real: la huella de tu móvil o Windows Hello).
const authenticator = new FakeAuthenticator('localhost', ORIGIN);

// 1. Registrar la llave.
const regOptions = await post('/api/webauthn/register/options', { userId: 'maria', userName: 'María (gerente)' });
const registered = await post('/api/webauthn/register/verify', {
  userId: 'maria',
  // La política exige rol autorizador para firmar pagos (sin rol → 'empleado' → 403).
  role: 'autorizador',
  response: authenticator.register(regOptions.body.options),
});
console.log(`1 · Llave registrada (${registered.status}): ${registered.body.credentialId?.slice(0, 12)}…`);

// 2. Un pago que exige firma.
const proposed = await post('/api/actions', {
  agentId: 'agente-compras',
  actionType: 'payment',
  amountMinor: 50000,
  currency: 'EUR',
  destination: 'amazon.es',
  justification: 'Renovación anual de licencias del equipo',
});
console.log(`2 · Propuesta (${proposed.status}): ${proposed.body.action?.id?.slice(0, 8)}… → ${proposed.body.action?.status}`);
const actionId: string = proposed.body.action.id;

// 3. Firmar: el reto es el hash de los datos exactos de la acción.
const options = await post(`/api/actions/${actionId}/sign/options`, { decision: 'approve' });
const signed = await post(`/api/actions/${actionId}/sign/verify`, {
  decision: 'approve',
  response: authenticator.assert(options.body.options),
});
console.log(`3 · Firma (${signed.status}): estado final → ${signed.body.action?.status}`);
console.log('   rastro de decisiones:');
for (const d of signed.body.action?.decisions ?? []) {
  console.log(`     - ${d.stage} · ${d.decision} · ${d.by.slice(0, 12)}…`);
}

// 4. Intentar reutilizar la firma: el reto ya se consumió y debe fallar.
const replay = await post(`/api/actions/${actionId}/sign/verify`, {
  decision: 'approve',
  response: authenticator.assert(options.body.options),
});
console.log(`4 · Reutilización de firma (${replay.status}): ${replay.body.error ?? 'INSEGURO: la firma se aceptó dos veces'}`);
