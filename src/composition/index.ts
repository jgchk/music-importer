import { mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BeetsBridge } from '../adapters/beets/bridge-adapter.js';
import { FilesystemIntake } from '../adapters/filesystem/intake.js';
import { InProcessEventBus } from '../adapters/sqlite/event-bus.js';
import { SqliteCheckpointStore, SqliteEventStore } from '../adapters/sqlite/event-store.js';
import { openEventDatabase } from '../adapters/sqlite/schema.js';
import { UpcasterRegistry } from '../adapters/sqlite/upcaster.js';
import { fetchHttpClient } from '../adapters/support/http.js';
import { WebhookDispatcher } from '../adapters/webhook/dispatcher.js';
import {
  DEFAULT_WEBHOOK_RETRY,
  WebhookPublisher,
} from '../application/events/webhook-publisher.js';
import { interpretEffect } from '../application/import/interpreter.js';
import type { InterpreterDeps } from '../application/import/interpreter.js';
import { Reactor } from '../application/import/reactor.js';
import type { UseCaseDeps } from '../application/import/use-cases.js';
import { createLogger } from '../application/logging/logger.js';
import type { Clock } from '../application/ports/system-ports.js';
import { ImportStatusProjection } from '../application/projections/read-models.js';
import { publishedEventMapping } from '../interfaces/contracts/events/mapping.js';
import { buildHttpApp } from '../interfaces/http/app.js';
import { loadConfig } from './config.js';
import { readAppVersion } from './version.js';

/**
 * The composition root: the one place that constructs concretes and injects them — vanilla DI, no
 * container framework. It loads and validates config (12-factor), validates the beets
 * configuration through the bridge (fail loudly at boot, not at first import — design D3), wires
 * the SQLite event store + in-process bus, the bridge and intake adapters behind their ports, the
 * status projection, the durable reactor, and the HTTP + MCP interfaces, then wires graceful
 * shutdown. Intentionally excluded from unit coverage (the E2E tier exercises the wired app); the
 * testable seams — config parsing, version reading, the app builder — live beside it.
 */

const clock: Clock = { now: () => new Date() };

async function main(): Promise<void> {
  const logger = createLogger();

  const configResult = loadConfig(process.env);
  if (configResult.isErr()) {
    logger.error({ error: configResult.error }, 'invalid configuration; aborting startup');
    process.exit(1);
  }
  const config = configResult.value;

  // --- Beets bridge: validate the user's config before serving anything (D3) -------------------
  const tagger = new BeetsBridge(logger, {
    pythonBin: config.bridgePython,
    beetsConfigPath: config.beetsConfigPath,
    timeoutMs: config.bridgeTimeoutMs,
  });
  const beetsConfig = await tagger.validate();
  if (beetsConfig.isErr()) {
    logger.error({ err: beetsConfig.error }, 'beets configuration unusable; aborting startup');
    process.exit(1);
  }
  logger.info(
    { beetsVersion: beetsConfig.value.beetsVersion, plugins: beetsConfig.value.plugins },
    'beets configuration validated',
  );

  // --- Persistence + bus -----------------------------------------------------------------------
  mkdirSync(dirname(config.databaseFile), { recursive: true });
  const db = openEventDatabase(config.databaseFile);
  const bus = new InProcessEventBus();
  const store = new SqliteEventStore(db, new UpcasterRegistry(), bus);
  const checkpoints = new SqliteCheckpointStore(db);

  // --- Projections (rebuilt from the log at startup, then followed live) -----------------------
  const status = new ImportStatusProjection();
  const backlog = await store.readAll(0);
  if (backlog.isOk()) {
    status.rebuild(backlog.value);
  } else {
    logger.error({ err: backlog.error }, 'projection rebuild failed');
  }
  bus.subscribe((stored) => {
    status.apply(stored);
  });

  // --- The durable reactor (fires bridge/intake effects; feeds results back through decide) ----
  const intake = new FilesystemIntake({ intakeRoot: config.intakeRoot }, logger);
  const interpreter: InterpreterDeps = { store, clock, ports: { tagger, intake } };
  const reactor = new Reactor({
    store,
    checkpoints,
    bus,
    logger,
    interpret: (importId, effect) => interpretEffect(interpreter, importId, effect),
  });
  await reactor.start();

  // --- The outbound verdict publisher (config-dormant): one more checkpointed consumer of the
  //     event store (the store IS the outbox), delivering `release.verdict` events to each
  //     subscriber independently, in order, at-least-once. Absent VERDICT_WEBHOOK_URLS, nothing
  //     here exists. -----------------------------------------------------------------------------
  let publisher: WebhookPublisher | undefined;
  if (config.verdictWebhooks === undefined) {
    logger.info('verdict webhook publisher dormant (no VERDICT_WEBHOOK_URLS)');
  } else {
    const dispatcher = new WebhookDispatcher(logger, fetchHttpClient, clock, {
      secret: config.verdictWebhooks.secret,
    });
    publisher = new WebhookPublisher({
      store,
      checkpoints,
      bus,
      logger,
      mapping: publishedEventMapping,
      deliver: dispatcher,
      subscribers: config.verdictWebhooks.urls,
      retry: DEFAULT_WEBHOOK_RETRY,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    await publisher.start();
    logger.info(
      { subscribers: config.verdictWebhooks.urls.length },
      'verdict webhook publisher active',
    );
  }

  // --- Inbound interfaces: one HTTP server serves both REST and MCP (streamable HTTP) ----------
  const deps: UseCaseDeps = {
    store,
    clock,
    status,
    policy: { autoApplyThreshold: config.autoApplyThreshold },
  };
  // The acquisition webhook receiver is config-dormant: no secret, no route (downloader-intake D2).
  const intakeWebhook = config.intakeWebhook;
  const httpApp = await buildHttpApp(deps, logger, readAppVersion(), {
    beetsConfig: beetsConfig.value,
    intake:
      intakeWebhook === undefined
        ? undefined
        : {
            secret: intakeWebhook.secret,
            sourceRoot: intakeWebhook.sourceRoot,
            intakeRoot: config.intakeRoot,
            directoryExists: async (directory) => {
              try {
                return (await stat(directory)).isDirectory();
              } catch {
                return false;
              }
            },
          },
  });
  if (intakeWebhook === undefined) {
    logger.info('acquisition webhook receiver dormant (no INTAKE_WEBHOOK_SECRET)');
  } else {
    logger.info(
      { sourceRoot: intakeWebhook.sourceRoot, intakeRoot: config.intakeRoot },
      'acquisition webhook receiver active',
    );
  }
  await httpApp.listen({ port: config.httpPort, host: config.host });

  logger.info({ port: config.httpPort, host: config.host }, 'music-importer started');

  // --- Graceful shutdown: stop reacting, drain in-flight HTTP (incl. MCP), close resources -----
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    reactor.stop();
    publisher?.stop();
    await httpApp.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  process.exit(1);
});
