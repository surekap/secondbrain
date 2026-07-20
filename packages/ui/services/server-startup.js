'use strict';

async function runServerStartup({
  db,
  runSystemSchema,
  runMigrations,
  migrateEnvToDb,
  ensurePuppeteerChrome,
  initializeAgentSupervisor,
  onSupervisorError,
  listen,
}) {
  if (db) {
    await runSystemSchema();
    await runMigrations();
    await migrateEnvToDb();
  }

  await ensurePuppeteerChrome();

  try {
    await initializeAgentSupervisor();
  } catch (err) {
    onSupervisorError(err);
  }

  return listen();
}

function terminateOnStartupFailure(startupPromise, {
  logger = console,
  exit = process.exit,
} = {}) {
  return Promise.resolve(startupPromise).catch((err) => {
    logger.error('[server] startup failed:', err.message);
    exit(1);
  });
}

module.exports = {
  runServerStartup,
  terminateOnStartupFailure,
};
