import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const { db, vault } = await bootstrap(config, log);
  const app = createApp({ vault, config, log });

  const server = app.listen(config.port, config.host, () => {
    log.info('Project Vault listening', { host: config.host, port: config.port, mcp: '/mcp' });
  });

  const shutdown = (signal: string) => {
    log.info('Shutting down', { signal });
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
