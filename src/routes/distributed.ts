import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { probeManager } from '../websocket/probeManager.js';
import { parseAddress, resolveSrvRecord, resolveIp, collectDnsRecords } from '../services/dns.js';
import { lookupLocation, lookupAsn } from '../services/geoip.js';
import { DistributedResult, NodeResult, IpInfo } from '../types/index.js';

interface DistributedParams {
  server: string;
}

interface DistributedQuery {
  type?: 'java' | 'bedrock';
}

export async function distributedRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: DistributedParams; Querystring: DistributedQuery }>(
    '/v1/distributed/:server',
    async (
      request: FastifyRequest<{ Params: DistributedParams; Querystring: DistributedQuery }>,
      reply: FastifyReply
    ) => {
      const { server } = request.params;
      const { type } = request.query;

      // Require type parameter
      if (!type) {
        reply.status(400);
        return { error: 'Missing required parameter: type (java or bedrock)' };
      }

      const probes = probeManager.getAllProbes();
      if (probes.length === 0) {
        reply.status(503);
        return { error: 'No probe nodes available' };
      }

      const { host, port } = parseAddress(server);

      // Quick check: is this an IP address already?
      const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
        /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^::1$|^::$/.test(host);

      // Note: In distributed mode, we let probes report their own errors
      // rather than fast-failing here, so each node shows its result

      // Determine the port to use
      // For Bedrock: use 19132 if default Java port was specified
      const targetPort = type === 'bedrock' && port === 25565 ? 19132 : port;

      // Run DNS resolution AND probe broadcast in parallel
      // Probes do their own DNS, so we don't need to wait for our DNS before sending
      const [dnsResult, probeResults] = await Promise.all([
        // DNS resolution (for IP info enrichment only)
        (async () => {
          // Fast-fail for obviously invalid hostnames - skip DNS entirely
          if (!isIpAddress && (host.length < 4 || (!host.includes('.') && host.length < 10))) {
            return { ip: null, srvRecord: null, dnsRecords: [] };
          }

          let srvRecord = null;
          let srvHost = host;

          if (type === 'java' && !isIpAddress) {
            srvRecord = await resolveSrvRecord(host);
            if (srvRecord) {
              srvHost = srvRecord.target;
            }
          }

          const ip = isIpAddress ? host : await resolveIp(srvHost);
          const dnsRecords = isIpAddress ? [] : await collectDnsRecords(host, srvRecord);

          return { ip, srvRecord, dnsRecords };
        })(),
        // Probe broadcast (runs in parallel)
        probeManager.broadcastTask(host, targetPort, type)
      ]);

      const { ip, srvRecord, dnsRecords } = dnsResult;
      const results = probeResults;

      // Build base IP info with DNS records
      const baseIpInfo: IpInfo | undefined = ip
        ? {
          ip,
          srv_record: srvRecord || undefined,
          asn: lookupAsn(ip) || undefined,
          location: lookupLocation(ip) || undefined,
          dns_records: dnsRecords.length > 0 ? dnsRecords : undefined,
        }
        : undefined;

      const nodes: Record<string, NodeResult> = {};
      for (const [probeId, result] of results) {
        const probe = probeManager.getProbe(probeId);

        let status = result.data || {
          online: false,
          host,
          port,
          error: result.error,
        };

        // Add IP info with DNS records to each node's status
        if (baseIpInfo) {
          status.ip_info = { ...baseIpInfo };
        }

        // Set type
        status.type = type;

        nodes[probeId] = {
          node_region: probe?.region || 'Unknown',
          status,
        };
      }

      const response: DistributedResult = {
        target: server,
        result_count: results.size,
        nodes,
      };

      return response;
    }
  );
}
