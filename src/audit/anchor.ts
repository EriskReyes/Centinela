/**
 * Anclaje externo del registro de auditoría.
 *
 * La cadena de hashes prueba que nadie ALTERÓ el registro después de
 * escribirlo; el anclaje prueba que nadie lo BORRÓ y empezó otro: cada N
 * entradas se publica la cabeza de la cadena (último hash + recuento) fuera
 * de MongoDB — a un archivo append-only y, opcionalmente, a un webhook/correo
 * en un sistema ajeno. Un atacante con acceso de administrador a Mongo no
 * puede reescribir el pasado sin que la copia externa lo delate.
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AnchorRecord {
  at: string;
  seq: number;
  hash: string;
  count: number;
}

/** Un intento de anclaje que FALLÓ (también se registra en el diario externo). */
export interface AnchorFailureRecord {
  kind: 'failure';
  at: string;
  error: string;
  httpStatus?: number;
}

export type JournalEntry = AnchorRecord | AnchorFailureRecord;

export function isAnchorFailure(entry: JournalEntry): entry is AnchorFailureRecord {
  return (entry as AnchorFailureRecord).kind === 'failure';
}

export type AnchorSink = (anchor: AnchorRecord) => Promise<void>;

/** Archivo append-only: nunca se sobrescribe; respáldalo o versiónalo aparte. */
export function createFileAnchorSink(filePath: string): AnchorSink {
  return async (anchor) => {
    await appendFile(filePath, JSON.stringify(anchor) + '\n', 'utf8');
  };
}

/** Registra un FALLO de anclaje en el mismo diario externo (fuera de Mongo). */
export function createJournalFailureSink(filePath: string): (failure: AnchorFailureRecord) => Promise<void> {
  return async (failure) => {
    await appendFile(filePath, JSON.stringify(failure) + '\n', 'utf8');
  };
}

/** Copia externa: webhook (o un servicio de correo) fuera de tu infraestructura. */
export function createWebhookAnchorSink(url: string): AnchorSink {
  return async (anchor) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anchor),
    });
    if (!res.ok) {
      throw new Error(`anclaje webhook fallido: HTTP ${res.status}`);
    }
  };
}

/** Configuración por defecto: archivo local + webhook si ANCHOR_WEBHOOK_URL está definido. */
export function defaultAnchorConfig(): {
  sinks: AnchorSink;
  filePath: string;
  journalFailure: (failure: AnchorFailureRecord) => Promise<void>;
} {
  const filePath = process.env.ANCHOR_FILE ?? path.join(process.cwd(), 'anchors.log');
  const sinks: AnchorSink[] = [createFileAnchorSink(filePath)];
  const webhook = process.env.ANCHOR_WEBHOOK_URL;
  if (webhook !== undefined && webhook.length > 0) {
    sinks.push(createWebhookAnchorSink(webhook));
  }
  const combined: AnchorSink = async (anchor) => {
    for (const sink of sinks) {
      await sink(anchor);
    }
  };
  return { sinks: combined, filePath, journalFailure: createJournalFailureSink(filePath) };
}

/** Lee la ÚLTIMA línea del diario externo (éxito o fallo). */
export async function readLastJournalEntry(filePath: string): Promise<JournalEntry | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return null;
    }
    return JSON.parse(lines[lines.length - 1] ?? 'null') as JournalEntry;
  } catch {
    return null; // aún no hay diario: nada que leer
  }
}

/** Lee el último anclaje EXITOSO del diario externo (salta las líneas de fallo). */
export async function readLastAnchorSuccess(filePath: string): Promise<AnchorRecord | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i] ?? 'null') as JournalEntry;
      if (!isAnchorFailure(entry)) {
        return entry;
      }
    }
    return null;
  } catch {
    return null;
  }
}
