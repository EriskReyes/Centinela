/**
 * Páginas HTML (panel y firma) con Content-Security-Policy por petición.
 *
 * Segunda línea de defensa contra XSS: aunque un dato del agente (destino,
 * justificación…) llegara a pintarse como HTML, el navegador solo ejecuta
 * los <script> que llevan el nonce de ESTA respuesta. Sin nonce, ni scripts
 * inyectados ni manejadores onerror=… ni javascript: en enlaces.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type express from 'express';

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Añade el nonce a cada etiqueta <script> del documento. */
export function withScriptNonce(html: string, nonce: string): string {
  return html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
}

export async function sendPage(res: express.Response, filePath: string): Promise<void> {
  const nonce = randomBytes(16).toString('base64');
  const html = await readFile(filePath, 'utf8');
  res
    .set({
      'Content-Security-Policy': contentSecurityPolicy(nonce),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    .type('html')
    .send(withScriptNonce(html, nonce));
}
