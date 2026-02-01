import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pingJavaServer } from '../services/minecraft/java.js';
import { pingBedrockServer } from '../services/minecraft/bedrock.js';
import { resolveSrvRecord, resolveIp, parseAddress, collectDnsRecords } from '../services/dns.js';
import { lookupLocation, lookupAsn } from '../services/geoip.js';
import { ServerStatus, IpInfo, AsnInfo } from '../types/index.js';

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

      // Require type parameter
      if (!type) {
        reply.status(400);
        return { error: 'Missing required parameter: type (java or bedrock)' };
      }

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
  type: 'java' | 'bedrock'
): Promise<ServerStatus> {
  const original = parseAddress(address);
  let { host, port } = original;
  let srvRecord = null;
  let srvHost = host; // Keep original hostname for handshake

  // Quick check: is this an IP address?
  const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^::1$|^::$/.test(host);

  // Fast-fail for obviously invalid hostnames (too short, no dots)
  if (!isIpAddress && (host.length < 4 || (!host.includes('.') && host.length < 10))) {
    return {
      online: false,
      host: original.host,
      port: type === 'bedrock' ? (port === 25565 ? 19132 : port) : port,
      error: 'Invalid hostname',
    };
  }

  // Try SRV record for Java servers only (skip if already an IP address)
  if (type === 'java' && !isIpAddress) {
    srvRecord = await resolveSrvRecord(host);
    if (srvRecord) {
      srvHost = srvRecord.target;
      port = srvRecord.port;
    }
  }

  // Resolve IP for connection and GeoIP lookup
  const ip = await resolveIp(srvHost);

  // Check if srvHost is an IP address (could be different from original host after SRV resolution)
  const srvHostIsIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(srvHost) ||
    /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^::1$|^::$/.test(srvHost);

  // If not an IP and DNS resolution failed, return error immediately
  if (!ip && !srvHostIsIp) {
    return {
      online: false,
      host: original.host,
      port: type === 'bedrock' ? (port === 25565 ? 19132 : port) : port,
      error: `DNS resolution failed for ${srvHost}`,
    };
  }

  // Use resolved IP for connection, but keep hostname for handshake
  const connectHost = ip || srvHost;

  // Collect DNS records
  const dnsRecords = await collectDnsRecords(original.host, srvRecord);

  // Extract all unique IPs from DNS records (A and AAAA records)
  const allIps = dnsRecords
    .filter(r => r.type === 'A' || r.type === 'AAAA')
    .map(r => r.data);
  const uniqueIps = [...new Set(allIps)];

  // Look up ASN for each unique IP and deduplicate by ASN number
  const asnMap = new Map<number, AsnInfo>();
  for (const ipAddr of uniqueIps) {
    const asn = lookupAsn(ipAddr);
    if (asn && !asnMap.has(asn.number)) {
      asnMap.set(asn.number, asn);
    }
  }
  const allAsns = Array.from(asnMap.values());

  // Build IP info - always include DNS records if available
  const ipInfo: IpInfo | undefined = (ip || dnsRecords.length > 0)
    ? {
      ip: ip || undefined,
      ips: uniqueIps.length > 1 ? uniqueIps : undefined,
      srv_record: srvRecord || undefined,
      asn: allAsns.length > 1 ? allAsns : (allAsns[0] || undefined),
      location: ip ? (lookupLocation(ip) || undefined) : undefined,
      dns_records: dnsRecords.length > 0 ? dnsRecords : undefined,
    }
    : undefined;

  // Ping the server based on type
  let status: ServerStatus;
  let actualPort = port;

  try {
    if (type === 'bedrock') {
      // Use port 19132 for Bedrock if default Java port was used
      actualPort = port === 25565 ? 19132 : port;
      status = await pingBedrockServer(connectHost, actualPort);
      status.type = 'bedrock';
    } else {
      // Java: pass original hostname for handshake, IP for connection
      status = await pingJavaServer(host, port, 5000, connectHost);
      status.type = 'java';
    }
  } catch (err) {
    status = {
      online: false,
      host: original.host,
      port: actualPort,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Add IP info to status
  if (ipInfo) {
    status.ip_info = ipInfo;
  }

  // Update host/port
  status.host = original.host;
  if (!srvRecord) {
    status.port = actualPort;
  }

  return status;
}
