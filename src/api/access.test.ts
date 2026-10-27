import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentMayAccess, generateToken, parseAgentTokens, resolvePrincipal, validateAccessConfig } from './access.ts';
import { TEST_ACCESS, TEST_ADMIN_TOKEN, TEST_AGENT_ID, TEST_AGENT_TOKEN } from './testAccess.ts';

describe('control de acceso — tokens', () => {
  it('reconoce al admin y a cada agente por su token', () => {
    assert.deepEqual(resolvePrincipal(TEST_ACCESS, `Bearer ${TEST_ADMIN_TOKEN}`), { kind: 'admin' });
    assert.deepEqual(resolvePrincipal(TEST_ACCESS, `Bearer ${TEST_AGENT_TOKEN}`), { kind: 'agent', agentId: TEST_AGENT_ID });
  });

  it('no reconoce tokens ausentes, vacíos, inventados o sin esquema Bearer', () => {
    for (const header of [undefined, '', 'Bearer ', 'Bearer inventado', TEST_ADMIN_TOKEN, `Basic ${TEST_ADMIN_TOKEN}`]) {
      assert.equal(resolvePrincipal(TEST_ACCESS, header), null);
    }
  });

  it('lee CENTINELA_AGENT_TOKENS y rechaza entradas mal formadas o duplicadas', () => {
    assert.deepEqual(parseAgentTokens(' a=x , b=y '), { a: 'x', b: 'y' });
    assert.throws(() => parseAgentTokens('sin-igual'));
    assert.throws(() => parseAgentTokens('a='));
    assert.throws(() => parseAgentTokens('a=x,a=y'));
  });

  it('rechaza tokens cortos o compartidos entre identidades', () => {
    const admin = generateToken();
    assert.throws(() => validateAccessConfig({ adminToken: 'corto', agentTokens: {} }));
    assert.throws(() => validateAccessConfig({ adminToken: admin, agentTokens: { a: 'corto' } }));
    assert.throws(() => validateAccessConfig({ adminToken: admin, agentTokens: { a: admin } }));
    const shared = generateToken();
    assert.throws(() => validateAccessConfig({ adminToken: admin, agentTokens: { a: shared, b: shared } }));
    assert.doesNotThrow(() => validateAccessConfig({ adminToken: admin, agentTokens: { a: generateToken() } }));
  });
});

describe('control de acceso — rutas del agente', () => {
  it('el agente solo propone y consulta acciones concretas', () => {
    assert.equal(agentMayAccess('POST', '/actions'), true);
    assert.equal(agentMayAccess('GET', '/actions/abc'), true);
  });

  it('todo lo demás es del admin (fail-closed)', () => {
    for (const [method, path] of [
      ['GET', '/actions'],
      ['GET', '/actions/pending'],
      ['GET', '/policy'],
      ['PUT', '/policy'],
      ['GET', '/stats'],
      ['POST', '/webauthn/register/options'],
      ['POST', '/webauthn/register/verify'],
      ['DELETE', '/webauthn/credentials/abc'],
      ['POST', '/actions/abc/sign/options'],
      ['POST', '/actions/abc/sign/verify'],
      ['GET', '/audit'],
      ['GET', '/una-ruta-que-aun-no-existe'],
    ]) {
      assert.equal(agentMayAccess(method!, path!), false, `${method} ${path}`);
    }
  });
});
