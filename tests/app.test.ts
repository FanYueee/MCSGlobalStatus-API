import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/app.js';
import {
  buildDistributedCacheKey,
  buildProbeFingerprint,
  buildStatusCacheKey,
  evaluateCacheBypass,
  QueryCache,
  queryCache,
} from '../src/services/queryCache.js';
import { probeManager } from '../src/websocket/probeManager.js';
import type { ProbeNode, PingResult } from '../src/types/index.js';

type EnvOverrides = Record<string, string | undefined>;

async function createTestServer(env: EnvOverrides = {}) {
  queryCache.clear();
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
      queryCache.clear();
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

test('status cache keys normalize standard and bedrock targets', () => {
  assert.equal(
    buildStatusCacheKey('MC.Hypixel.Net', 'java'),
    buildStatusCacheKey('mc.hypixel.net:25565', 'java')
  );
  assert.equal(
    buildStatusCacheKey('bedrock.example.com', 'bedrock'),
    buildStatusCacheKey('bedrock.example.com:19132', 'bedrock')
  );
});

test('distributed cache keys include probe fingerprint', () => {
  const probesA = [
    { id: 'tokyo-1', region: 'Tokyo' },
    { id: 'sfo-1', region: 'SanFrancisco' },
  ];
  const probesB = [
    { id: 'tokyo-1', region: 'Tokyo' },
  ];

  assert.equal(buildProbeFingerprint(probesA), 'sfo-1@SanFrancisco,tokyo-1@Tokyo');
  assert.notEqual(
    buildDistributedCacheKey('1.1.1.1', 'bedrock', probesA),
    buildDistributedCacheKey('1.1.1.1', 'bedrock', probesB)
  );
});

test('query cache returns hit after first load and bypass refreshes the value', async () => {
  const cache = new QueryCache(300_000);
  let counter = 0;

  const first = await cache.getOrLoad('demo', async () => {
    counter += 1;
    return { value: counter };
  });
  const second = await cache.getOrLoad('demo', async () => {
    counter += 1;
    return { value: counter };
  });
  const bypassed = await cache.getOrLoad('demo', async () => {
    counter += 1;
    return { value: counter };
  }, { bypass: true });
  const afterBypass = await cache.getOrLoad('demo', async () => {
    counter += 1;
    return { value: counter };
  });

  assert.equal(first.status, 'MISS');
  assert.deepEqual(first.value, { value: 1 });
  assert.equal(second.status, 'HIT');
  assert.deepEqual(second.value, { value: 1 });
  assert.equal(bypassed.status, 'BYPASS');
  assert.deepEqual(bypassed.value, { value: 2 });
  assert.equal(afterBypass.status, 'HIT');
  assert.deepEqual(afterBypass.value, { value: 2 });
  assert.equal(counter, 2);
});

test('cache bypass requires the configured admin token', () => {
  assert.deepEqual(evaluateCacheBypass(undefined, undefined, 'secret'), {
    requested: false,
    bypass: false,
    authorized: false,
  });
  assert.deepEqual(evaluateCacheBypass('1', undefined, 'secret'), {
    requested: true,
    bypass: false,
    authorized: false,
  });
  assert.deepEqual(evaluateCacheBypass('true', 'secret', 'secret'), {
    requested: true,
    bypass: true,
    authorized: true,
  });
});

test('GET /v1/status uses cache and ignores invalid bypass tokens', async (t) => {
  const { fastify, restoreEnv } = await createTestServer({
    CACHE_BYPASS_TOKEN: 'secret',
  });
  t.after(async () => {
    await fastify.close();
    restoreEnv();
  });

  const first = await fastify.inject({
    method: 'GET',
    url: '/v1/status/abc?type=java',
  });
  const second = await fastify.inject({
    method: 'GET',
    url: '/v1/status/abc?type=java',
  });
  const ignoredBypass = await fastify.inject({
    method: 'GET',
    url: '/v1/status/abc?type=java&fresh=1',
  });
  const bypassed = await fastify.inject({
    method: 'GET',
    url: '/v1/status/abc?type=java&fresh=1',
    headers: {
      'x-mcs-cache-bypass-token': 'secret',
    },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-mcs-cache-status'], 'MISS');
  assert.equal(second.headers['x-mcs-cache-status'], 'HIT');
  assert.equal(ignoredBypass.statusCode, 200);
  assert.equal(ignoredBypass.headers['x-mcs-cache-status'], 'HIT');
  assert.equal(bypassed.statusCode, 200);
  assert.equal(bypassed.headers['x-mcs-cache-status'], 'BYPASS');
});

test('GET /v1/distributed uses cache for repeated probe queries and supports admin bypass', async (t) => {
  const probes: Pick<ProbeNode, 'id' | 'region'>[] = [
    { id: 'local-01', region: 'Local' },
  ];
  let broadcasts = 0;
  const getAllProbesMock = mock.method(probeManager, 'getAllProbes', () => probes as ProbeNode[]);
  const getProbeMock = mock.method(probeManager, 'getProbe', (id: string) => {
    return probes.find((probe) => probe.id === id) as ProbeNode | undefined;
  });
  const broadcastTaskMock = mock.method(probeManager, 'broadcastTask', async (): Promise<Map<string, PingResult>> => {
    broadcasts += 1;
    return new Map([
      ['local-01', {
        id: `task-${broadcasts}`,
        success: true,
        data: {
          online: true,
          host: '1.1.1.1',
          port: 19132,
          latency: 12,
          players: {
            online: 1,
            max: 20,
          },
          motd: {
            raw: 'Demo',
            clean: 'Demo',
            html: '<span>Demo</span>',
          },
        },
      }],
    ]);
  });

  const { fastify, restoreEnv } = await createTestServer({
    CACHE_BYPASS_TOKEN: 'secret',
  });

  t.after(async () => {
    broadcastTaskMock.mock.restore();
    getProbeMock.mock.restore();
    getAllProbesMock.mock.restore();
    await fastify.close();
    restoreEnv();
  });

  const first = await fastify.inject({
    method: 'GET',
    url: '/v1/distributed/1.1.1.1?type=bedrock',
  });
  const second = await fastify.inject({
    method: 'GET',
    url: '/v1/distributed/1.1.1.1?type=bedrock',
  });
  const ignoredBypass = await fastify.inject({
    method: 'GET',
    url: '/v1/distributed/1.1.1.1?type=bedrock&fresh=1',
    headers: {
      'x-mcs-cache-bypass-token': 'wrong-token',
    },
  });
  const bypassed = await fastify.inject({
    method: 'GET',
    url: '/v1/distributed/1.1.1.1?type=bedrock&fresh=1',
    headers: {
      'x-mcs-cache-bypass-token': 'secret',
    },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-mcs-cache-status'], 'MISS');
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['x-mcs-cache-status'], 'HIT');
  assert.equal(ignoredBypass.statusCode, 200);
  assert.equal(ignoredBypass.headers['x-mcs-cache-status'], 'HIT');
  assert.equal(bypassed.statusCode, 200);
  assert.equal(bypassed.headers['x-mcs-cache-status'], 'BYPASS');
  assert.equal(broadcasts, 2);
  assert.equal(first.json().result_count, 1);
  assert.equal(second.json().nodes['local-01'].node_region, 'Local');
});
