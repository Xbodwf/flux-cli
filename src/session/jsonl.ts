import { createWriteStream, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionEntry } from '../core/types.js';

const SESSION_DIR = join(homedir(), '.flux', 'sessions');

/**
 * JSONL Session — append-only, streaming-friendly, grep-able.
 *
 * Format: one JSON object per line, each with a timestamp and type.
 * Supports gzip compression (detected by .gz extension).
 */

/**
 * Write session entries to a JSONL file.
 */
export async function writeSession(
  sessionPath: string,
  entries: SessionEntry[],
  compress = false,
): Promise<void> {
  const path = compress ? `${sessionPath}.gz` : sessionPath;

  if (compress) {
    // For compressed: write to gzip stream, pipe to file
    const fileStream = createWriteStream(path);
    const gzip = createGzip();
    gzip.pipe(fileStream);

    for (const entry of entries) {
      gzip.write(JSON.stringify(entry) + '\n');
    }
    gzip.end();

    return new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
  }

  // Uncompressed: write directly to file
  const stream = createWriteStream(path);
  for (const entry of entries) {
    stream.write(JSON.stringify(entry) + '\n');
  }
  stream.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

/**
 * Append a single entry to an existing session file.
 */
export async function appendSessionEntry(
  sessionPath: string,
  entry: SessionEntry,
  compress = false,
): Promise<void> {
  const path = compress ? `${sessionPath}.gz` : sessionPath;
  const line = JSON.stringify(entry) + '\n';

  if (compress) {
    // For compressed files, we need to decompress, append, recompress
    const existing = await readSession(sessionPath, compress);
    existing.push(entry);
    await writeSession(sessionPath, existing, compress);
    return;
  }

  const handle = await open(path, 'a');
  await handle.writeFile(line);
  await handle.close();
}

/**
 * Read all entries from a session file.
 */
export async function readSession(
  sessionPath: string,
  compressed = false,
): Promise<SessionEntry[]> {
  const path = compressed ? `${sessionPath}.gz` : sessionPath;

  if (!existsSync(path)) {
    return [];
  }

  const entries: SessionEntry[] = [];

  return new Promise((resolve, reject) => {
    const stream = compressed
      ? createReadStream(path).pipe(createGunzip())
      : createReadStream(path);

    let buffer = '';
    stream.setEncoding('utf-8');

    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            entries.push(JSON.parse(line) as SessionEntry);
          } catch {
            // skip malformed lines
          }
        }
      }
    });

    stream.on('end', () => {
      if (buffer.trim()) {
        try {
          entries.push(JSON.parse(buffer) as SessionEntry);
        } catch { /* skip */ }
      }
      resolve(entries);
    });

    stream.on('error', reject);
  });
}

/**
 * List all saved sessions.
 */
export async function listSessions(): Promise<Array<{ name: string; compressed: boolean; size: number }>> {
  const { mkdirSync } = await import('node:fs');
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
    return [];
  }

  const files = await readdir(SESSION_DIR);
  const sessions: Array<{ name: string; compressed: boolean; size: number }> = [];

  for (const file of files) {
    const stat = (await import('node:fs')).statSync(join(SESSION_DIR, file));
    sessions.push({
      name: file.replace(/\.gz$/, '').replace(/\.jsonl$/, ''),
      compressed: file.endsWith('.gz'),
      size: stat.size,
    });
  }

  return sessions.sort((a, b) => b.size - a.size);
}

/**
 * Get the default session path for a given name/timestamp.
 */
export function getSessionPath(name?: string): string {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
  const sessionName = name || `session-${Date.now()}`;
  return join(SESSION_DIR, sessionName + '.jsonl');
}
