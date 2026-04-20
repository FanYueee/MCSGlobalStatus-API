import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/app.js';

type EnvOverrides = Record<string, string | undefined>;

async function createTestServer(env: EnvOverrides = {}) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const fastify = await createServer({ logger: false, watchProbeSecrets: false });

  return {
    fastify,
    restoreEnv() {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

test('GET /health returns ok and geoip status', async (t) => {
  const { fastify, restoreEnv } = await createTestServer();
  t.after(async () => {
    await fastify.close();
    restoreEnv();
  });

  const response = await fastify.inject({
    method: 'GET',
    url: '/health',
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.status, 'ok');
  assert.equal(typeof payload.geoip_loaded, 'boolean');
  assert.equal(typeof payload.server_time, 'string');
});

test('GET /health/details returns 403 when allowlist is empty', async (t) => {
  const { fastify, restoreEnv } = await createTestServer({
    HEALTH_DETAILS_WHITELIST: '',
  });
  t.after(async () => {
    await fastify.close();
    restoreEnv();
  });

  const response = await fastify.inject({
    method: 'GET',
    url: '/health/details',
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: 'Forbidden' });
});

test('GET /health/details returns details when localhost is allowed', async (t) => {
  const { fastify, restoreEnv } = await createTestServer({
    HEALTH_DETAILS_WHITELIST: '127.0.0.1',
  });
  t.after(async () => {
    await fastify.close();
    restoreEnv();
  });

  const response = await fastify.inject({
    method: 'GET',
    url: '/health/details',
    remoteAddress: '127.0.0.1',
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.status, 'ok');
  assert.equal(typeof payload.geoip.loaded, 'boolean');
  assert.ok(Array.isArray(payload.probe_nodes));
});

test('GET /v1/status rejects requests without type', async (t) => {
  const { fastify, restoreEnv } = await createTestServer();
  t.after(async () => {
    await fastify.close();
    restoreEnv();
  });

  const response = await fastify.inject({
    method: 'GET',
    url: '/v1/status/mc.hypixel.net',
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'Missing required parameter: type (java or bedrock)');
});

test('GET /v1/distributed returns 503 when no probes are connected', async (t) => {
  const { fastify, restoreEnv } = await createTestServer();
  t.after(async () => {
    await fastify.close();
    restoreEnv();
  });

  const response = await fastify.inject({
    method: 'GET',
    url: '/v1/distributed/mc.hypixel.net?type=java',
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'No probe nodes available');
});
