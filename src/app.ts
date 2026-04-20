import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { statusRoutes } from './routes/status.js';
import { distributedRoutes } from './routes/distributed.js';
import { setupWebSocket } from './websocket/server.js';
import { initGeoIP, getGeoIPStatus } from './services/geoip.js';
import { probeManager } from './websocket/probeManager.js';
import { parseIpAllowlist, isIpAllowed, formatIpForLog } from './security/ipAllowlist.js';

interface RuntimeConfig {
  port: number;
  host: string;
  trustProxy: boolean;
  corsOrigins: string[];
  healthDetailsWhitelist: string[];
}

interface CreateServerOptions {
  logger?: boolean;
  watchProbeSecrets?: boolean;
}

function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    port: parseInt(env.PORT || '3000', 10),
    host: env.HOST || '0.0.0.0',
    trustProxy: env.TRUST_PROXY === 'true',
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    healthDetailsWhitelist: parseIpAllowlist(env.HEALTH_DETAILS_WHITELIST),
  };
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const config = readRuntimeConfig();
  const fastify = Fastify({
    logger: options.logger ?? true,
    trustProxy: config.trustProxy,
  });

  await fastify.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
  });

  if (config.corsOrigins.length > 0) {
    fastify.log.info({ cors_origins: config.corsOrigins }, 'CORS allowlist enabled');
  } else {
    fastify.log.warn('CORS allowlist is empty; cross-origin browser access is disabled');
  }

  if (config.healthDetailsWhitelist.length > 0) {
    fastify.log.info({ health_details_whitelist: config.healthDetailsWhitelist }, 'Health details IP allowlist enabled');
  } else {
    fastify.log.warn('Health details IP allowlist is empty; /health/details will reject every request');
  }

  await fastify.register(websocket);

  const geoipReady = await initGeoIP();
  if (geoipReady) {
    fastify.log.info({ geoip: getGeoIPStatus() }, 'GeoIP databases loaded');
  } else {
    fastify.log.warn({ geoip: getGeoIPStatus() }, 'GeoIP databases not found, IP info will be limited');
  }

  await fastify.register(statusRoutes);
  await fastify.register(distributedRoutes);
  await setupWebSocket(fastify, { watchSecrets: options.watchProbeSecrets });

  fastify.get('/health', async () => {
    return {
      status: 'ok',
      geoip_loaded: getGeoIPStatus().loaded,
      server_time: new Date().toISOString(),
    };
  });

  fastify.get('/health/details', async (request, reply) => {
    const requestIp = formatIpForLog(request.ip);
    if (!isIpAllowed(requestIp, config.healthDetailsWhitelist)) {
      fastify.log.warn({ ip: requestIp }, 'Blocked /health/details request from non-whitelisted IP');
      reply.code(403);
      return {
        error: 'Forbidden',
      };
    }

    return {
      status: 'ok',
      geoip: getGeoIPStatus(),
      probes: probeManager.getProbeCount(),
      pending_tasks: probeManager.getPendingTaskCount(),
      observability: probeManager.getObservabilitySummary(),
      server_time: new Date().toISOString(),
      probe_nodes: probeManager.getProbeHealthSummaries(),
    };
  });

  fastify.get('/', async () => {
    return {
      name: 'MCSAPI',
      version: '1.0.0',
      geoip_loaded: getGeoIPStatus().loaded,
      endpoints: {
        status: '/v1/status/{server}',
        distributed: '/v1/distributed/{server}',
        stream: '/v1/stream (WebSocket)',
        health: {
          public: '/health',
          details: '/health/details',
          details_access: 'whitelisted IPs only',
        },
      },
    };
  });

  return fastify;
}

export async function startServer(): Promise<FastifyInstance> {
  const config = readRuntimeConfig();
  const fastify = await createServer();

  try {
    await fastify.listen({ port: config.port, host: config.host });
    fastify.log.info(`MCSAPI Controller running on http://${config.host}:${config.port}`);
    return fastify;
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

function parseOrigins(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
