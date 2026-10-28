import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasControlChars, hasParentSegment, normalizePath } from './paths.ts';

describe('normalizePath', () => {
  it('unifica barras, colapsa repetidas y quita segmentos "."', () => {
    assert.equal(normalizePath('repo:centinela\\docs\\guia.md'), 'repo:centinela/docs/guia.md');
    assert.equal(normalizePath('repo:centinela//docs/./guia.md'), 'repo:centinela/docs/guia.md');
    assert.equal(normalizePath('/etc//passwd'), '/etc/passwd');
    assert.equal(normalizePath('C:\\Windows\\System32\\x'), 'C:/Windows/System32/x');
    assert.equal(normalizePath('repo:centinela/docs/'), 'repo:centinela/docs');
  });

  it('no estropea esquemas con //', () => {
    assert.equal(normalizePath('https://ejemplo.com//a'), 'https://ejemplo.com/a');
  });

  it('detecta ".." y caracteres de control', () => {
    assert.equal(hasParentSegment('repo:centinela/docs/../.env'), true);
    assert.equal(hasParentSegment('repo:centinela\\docs\\..\\.env'), true);
    assert.equal(hasParentSegment('repo:centinela/docs/a..b.md'), false);
    assert.equal(hasControlChars('docs/guia.md\u0000.png'), true);
    assert.equal(hasControlChars('docs/guia.md'), false);
  });
});
