import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pingJavaServer } from '../services/minecraft/java.js';
import { pingBedrockServer } from '../services/minecraft/bedrock.js';
import { resolveSrvRecord, resolveIp, parseAddress } from '../services/dns.js';
import { lookupLocation, lookupAsn } from '../services/geoip.js';
import { ServerStatus, IpInfo } from '../types/index.js';

interface StatusParams {
  server: string;
}

interface StatusQuery {
  type?: 'java' | 'bedrock';
}

export async function statusRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: StatusParams; Querystring: StatusQuery }>(
    '/v1/status/:server',
    async (request: FastifyRequest<{ Params: StatusParams; Querystring: StatusQuery }>, reply: FastifyReply) => {
      const { server } = request.params;
      const { type } = request.query;

      try {
        const result = await getServerStatus(server, type);
        return result;
      } catch (err) {
        reply.status(500);
        return { error: 'Internal server error' };
      }
    }
  );
}

export async function getServerStatus(
  address: string,
  type?: 'java' | 'bedrock'
): Promise<ServerStatus> {
  const original = parseAddress(address);
  let { host, port } = original;
  let srvRecord = null;
  let srvHost = host; // Keep original hostname for handshake

  // Try SRV record for Java servers
  if (!type || type === 'java') {
    srvRecord = await resolveSrvRecord(host);
    if (srvRecord) {
      srvHost = srvRecord.target;
      port = srvRecord.port;
    }
  }

  // Resolve IP for connection and GeoIP lookup
  const ip = await resolveIp(srvHost);

  // Use resolved IP for connection, but keep hostname for handshake
  const connectHost = ip || srvHost;

  // Build IP info
  const ipInfo: IpInfo | undefined = ip
    ? {
        ip,
        srv_record: srvRecord || undefined,
        asn: lookupAsn(ip) || undefined,
        location: lookupLocation(ip) || undefined,
      }
    : undefined;

  // Try to ping the server
  let status: ServerStatus;

  try {
    if (type === 'bedrock') {
      status = await pingBedrockServer(connectHost, port);
    } else if (type === 'java') {
      // Pass original hostname for handshake, IP for connection
      status = await pingJavaServer(host, port, 5000, connectHost);
    } else {
      // Auto-detect: try Java first, then Bedrock
      status = await pingJavaServer(host, port, 5000, connectHost);
      if (!status.online) {
        const bedrockStatus = await pingBedrockServer(connectHost, port === 25565 ? 19132 : port);
        if (bedrockStatus.online) {
          status = bedrockStatus;
        }
      }
    }
  } catch (err) {
    status = {
      online: false,
      host: original.host,
      port: original.port,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Add IP info to status
  if (ipInfo) {
    status.ip_info = ipInfo;
  }

  // Update host/port to original request
  status.host = original.host;
  if (!srvRecord) {
    status.port = original.port;
  }

  return status;
}
