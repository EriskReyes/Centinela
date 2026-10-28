/**
 * Rutas de archivo y destinos de programa: una sola forma canónica.
 *
 * Sin esto, `docs/../.env` "está dentro de docs/" y `C:\WINDOWS\x` no es
 * `C:\Windows*`. Reglas:
 *  - `\` pasa a `/` y las barras repetidas se colapsan (salvo tras `esquema:`).
 *  - Los segmentos `.` se eliminan.
 *  - Los segmentos `..` NO se resuelven: una ruta con `..` se rechaza entera
 *    (el motor la bloquea). Resolverlos exigiría saber la raíz real del
 *    sistema de archivos, y equivocarse ahí es exactamente el ataque.
 */
export function normalizePath(raw: string): string {
  const unified = raw.trim().replace(/\\/g, '/').replace(/(?<!:)\/{2,}/g, '/');
  const leading = unified.startsWith('/') ? '/' : '';
  const segments = unified
    .slice(leading.length)
    .split('/')
    .filter((segment, index, all) => segment !== '.' && !(segment === '' && index === all.length - 1 && index > 0));
  return leading + segments.join('/');
}

/** ¿Algún segmento intenta salir del directorio (`..`)? */
export function hasParentSegment(path: string): boolean {
  return path.replace(/\\/g, '/').split('/').some((segment) => segment.trim() === '..');
}

/** Caracteres de control (NUL, saltos de línea…): nunca válidos en un destino. */
export function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
