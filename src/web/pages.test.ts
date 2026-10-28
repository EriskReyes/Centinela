/**
 * XSS: el agente controla destino, justificación, operación… y esos datos se
 * pintan en /firmar y /panel. Dos defensas: escape en la página y CSP.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentSecurityPolicy, withScriptNonce } from './pages.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('CSP de las páginas', () => {
  it('solo ejecuta scripts con el nonce de la respuesta', () => {
    const csp = contentSecurityPolicy('abc123');
    assert.ok(csp.includes("script-src 'self' 'nonce-abc123'"));
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  });

  it('pone el nonce en cada <script> de la página, y en nada más', () => {
    const html = '<script src="/webauthn.js"></script><p>&lt;script&gt;</p><script>\nrun()</script><scripts></scripts>';
    assert.equal(
      withScriptNonce(html, 'N'),
      '<script nonce="N" src="/webauthn.js"></script><p>&lt;script&gt;</p><script nonce="N">\nrun()</script><scripts></scripts>',
    );
  });

  for (const page of ['../auth/firmar.html', 'panel.html']) {
    it(`${path.basename(page)}: todos sus <script> quedan con nonce y no hay manejadores en línea`, async () => {
      const html = await readFile(path.join(here, page), 'utf8');
      const served = withScriptNonce(html, 'N');
      const tags = served.match(/<script(?=[\s>])[^>]*>/g) ?? [];
      assert.ok(tags.length > 0);
      for (const tag of tags) assert.ok(tag.includes('nonce="N"'), tag);
      // onclick="…" y similares los bloquearía la CSP: la página no debe depender de ellos.
      assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i);
    });
  }
});

describe('/firmar no interpreta como HTML los datos del agente', () => {
  it('la tarjeta de cada acción se construye con textContent, no con innerHTML', async () => {
    const html = await readFile(path.join(here, '../auth/firmar.html'), 'utf8');
    assert.doesNotMatch(html, /card\.innerHTML/);
    // Ningún campo de la acción concatenado dentro de un innerHTML.
    for (const assignment of html.match(/innerHTML\s*=[\s\S]*?;\n/g) ?? []) {
      assert.doesNotMatch(assignment, /action\.|\.destination|\.justification|\.agentId|\.operation|\.reason/, assignment);
    }
  });
});
