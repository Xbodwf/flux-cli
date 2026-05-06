import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, extname } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const SESSION_DIR = join(homedir(), '.flux', 'sessions');

/**
 * Compress a session file with gzip.
 * Preserves original file; creates .jsonl.gz alongside.
 */
export async function compressSession(sessionPath: string): Promise<string> {
  const gzPath = `${sessionPath}.gz`;

  await pipeline(
    createReadStream(sessionPath),
    createGzip({ level: 6 }),
    createWriteStream(gzPath),
  );

  return gzPath;
}

/**
 * Decompress a .jsonl.gz session file.
 * If decompressToFile is true, writes the decompressed file.
 * Otherwise returns the decompressed content as string.
 */
export async function decompressSession(
  gzPath: string,
  decompressToFile = false,
): Promise<string> {
  const chunks: Buffer[] = [];

  await pipeline(
    createReadStream(gzPath),
    createGunzip(),
    async function* (source) {
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk));
      }
    },
  );

  const content = Buffer.concat(chunks).toString('utf-8');

  if (decompressToFile) {
    const outPath = gzPath.replace(/\.gz$/, '');
    await pipeline(
      createReadStream(gzPath),
      createGunzip(),
      createWriteStream(outPath),
    );
  }

  return content;
}

/**
 * Check if a file is gzip compressed.
 */
export function isCompressed(filePath: string): boolean {
  return extname(filePath) === '.gz';
}

/**
 * Auto-compress sessions in the session directory.
 * Useful for batch compression of legacy sessions.
 */
export async function compressAllSessions(): Promise<number> {
  if (!existsSync(SESSION_DIR)) return 0;

  const files = readdirSync(SESSION_DIR).filter(
    f => f.endsWith('.jsonl') && !f.endsWith('.gz'),
  );

  let count = 0;
  for (const file of files) {
    await compressSession(join(SESSION_DIR, file));
    count++;
  }

  return count;
}
