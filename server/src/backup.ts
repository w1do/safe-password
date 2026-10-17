import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/** Consistent online copy of the SQLite database (safe while the service is running, WAL included). */
export async function backupDatabase(dbPath: string, destination: string): Promise<void> {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
}

/**
 * CLI: writes a database snapshot to stdout.
 *   docker compose exec -T vault node server/dist/backup.js > vault.sqlite
 * The encryption key is NOT included — back up /data/config/master.key as well.
 */
async function main() {
  if (process.stdout.isTTY) {
    process.stderr.write('Refusing to write a binary database to a terminal. Redirect stdout to a file.\n');
    process.exit(2);
  }
  const dbPath = process.env.VAULT_DB_PATH ?? path.join(process.env.VAULT_DATA_DIR ?? '/data', 'db', 'vault.sqlite');
  const tmp = path.join(os.tmpdir(), `vault-backup-${process.pid}.sqlite`);
  try {
    await backupDatabase(dbPath, tmp);
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(tmp).on('error', reject).pipe(process.stdout).on('error', reject).on('finish', resolve);
      process.stdout.on('finish', resolve);
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`Backup failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
