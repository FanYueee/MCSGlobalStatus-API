import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { statusRoutes } from './routes/status.js';
import { distributedRoutes } from './routes/distributed.js';
import { setupWebSocket } from './websocket/server.js';
import { initGeoIP } from './services/geoip.js';
import { probeManager } from './websocket/probeManager.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const CORS_ORIGINS = parseOrigins(process.env.CORS_ORIGINS);

async function main() {
  const fastify = Fastify({
    logger: true,
    trustProxy: TRUST_PROXY,
  });

  // Register CORS
  await fastify.register(cors, {
    origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false
  });

  if (CORS_ORIGINS.length > 0) {
    fastify.log.info({ cors_origins: CORS_ORIGINS }, 'CORS allowlist enabled');
  } else {
    fastify.log.warn('CORS allowlist is empty; cross-origin browser access is disabled');
  }

  // Register WebSocket plugin
  await fastify.register(websocket);

  // Initialize GeoIP (optional)
  const geoipReady = await initGeoIP();
  if (geoipReady) {
    fastify.log.info('GeoIP databases loaded');
  } else {
    fastify.log.warn('GeoIP databases not found, IP info will be limited');
  }

  // Register routes
  await fastify.register(statusRoutes);
  await fastify.register(distributedRoutes);

  // Setup WebSocket for probe connections
  await setupWebSocket(fastify);

  // Health check endpoint
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      probes: probeManager.getProbeCount(),
      pending_tasks: probeManager.getPendingTaskCount(),
      server_time: new Date().toISOString(),
      probe_nodes: probeManager.getProbeHealthSummaries(),
    };
  });

  // Root endpoint
  fastify.get('/', async () => {
    return {
      name: 'MCSAPI',
      version: '1.0.0',
      endpoints: {
        status: '/v1/status/{server}',
        distributed: '/v1/distributed/{server}',
        stream: '/v1/stream (WebSocket)',
        health: '/health',
      },
    };
  });

  // Start server
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`MCSAPI Controller running on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();

function parseOrigins(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
