// test setup - automatically starts/stops services for tests
// this file is loaded via bunfig.toml preload

import { $ } from 'bun';

const SERVICES_FOR_TESTS = process.env.TEST_SERVICES?.split(',') || ['redis'];

async function startServices() {
  console.log('starting test services...');
  
  // use test environment file and start only needed services
  await $`docker compose --env-file .env.test up -d --wait ${SERVICES_FOR_TESTS.join(' ')}`.quiet();
  
  console.log('✓ test services ready');
}

async function stopServices() {
  console.log('stopping test services...');
  
  // stop all services and remove volumes
  await $`docker compose --env-file .env.test down -v`.quiet();
  
  console.log('✓ test services stopped');
}

// only run if not in CI and docker is enabled
if (process.env.CI !== 'true' && process.env.NO_DOCKER !== 'true') {
  // register cleanup
  process.on('beforeExit', async () => {
    await stopServices();
  });
  
  // start services
  await startServices();
}