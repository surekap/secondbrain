'use strict';

function redactConnectionCredentials(value) {
  return String(value || '').replace(/:\/\/[^\s/@]+@/g, '://[REDACTED]@');
}

function describeStartupError(error) {
  const name = error?.name || 'Error';
  const details = [];
  if (error?.code) details.push(`code=${error.code}`);
  if (error?.message) details.push(redactConnectionCredentials(error.message));

  const causes = Array.isArray(error?.errors)
    ? error.errors.map(cause => {
      const causeName = cause?.name || 'Error';
      const causeMessage = redactConnectionCredentials(cause?.message || 'no message');
      return `${causeName}: ${causeMessage}${cause?.code ? ` [code=${cause.code}]` : ''}`;
    })
    : [];

  if (causes.length > 0) details.push(`causes=${causes.join('; ')}`);
  if (details.length === 0) return name;
  if (name === 'Error' && !error?.code && causes.length === 0) return details[0];
  return `${name} (${details.join('; ')})`;
}

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
  beforeExit = async () => {},
  exit = process.exit,
} = {}) {
  return Promise.resolve(startupPromise).catch(async (err) => {
    logger.error('[server] startup failed:', describeStartupError(err));
    try {
      await beforeExit(err);
    } catch (cleanupError) {
      logger.error('[server] startup cleanup failed:', cleanupError.message);
    }
    exit(1);
  });
}

module.exports = {
  runServerStartup,
  terminateOnStartupFailure,
};
