import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { probeManager } from '../websocket/probeManager.js';
import { parseAddress } from '../services/dns.js';
import { lookupLocation, lookupAsn } from '../services/geoip.js';
import { DistributedResult, NodeResult, IpInfo, AsnInfo } from '../types/index.js';
import { createRateLimitHook } from '../security/rateLimit.js';

interface DistributedParams {
  server: string;
}

interface DistributedQuery {
  type?: 'java' | 'bedrock';
}

export async function distributedRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: DistributedParams; Querystring: DistributedQuery }>(
    '/v1/distributed/:server',
    {
      onRequest: createRateLimitHook('distributed'),
    },
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

      // Note: In distributed mode, we let probes report their own errors
      // rather than fast-failing here, so each node shows its result

      // Determine the port to use
      // For Bedrock: use 19132 if default Java port was specified
      const targetPort = type === 'bedrock' && port === 25565 ? 19132 : port;

      // Probes resolve DNS locally; controller only aggregates and enriches the returned IP info
      const results = await probeManager.broadcastTask(host, targetPort, type);

      const nodes: Record<string, NodeResult> = {};
      for (const [probeId, result] of results) {
        const probe = probeManager.getProbe(probeId);

        let status = result.data || {
          online: false,
          host,
          port,
          error: result.error,
        };

        const probeIpInfo = status.ip_info;
        if (probeIpInfo) {
          const uniqueIps = [...new Set([
            ...(probeIpInfo.ips || []),
            ...(probeIpInfo.ip ? [probeIpInfo.ip] : []),
          ])];

          const asnMap = new Map<number, AsnInfo>();
          for (const ipAddr of uniqueIps) {
            const asn = lookupAsn(ipAddr);
            if (asn && !asnMap.has(asn.number)) {
              asnMap.set(asn.number, asn);
            }
          }
          const allAsns = Array.from(asnMap.values());

          const enrichedIpInfo: IpInfo = {
            ...probeIpInfo,
            ips: uniqueIps.length > 1 ? uniqueIps : undefined,
            asn: allAsns.length > 1 ? allAsns : (allAsns[0] || undefined),
            location: probeIpInfo.ip ? (lookupLocation(probeIpInfo.ip) || undefined) : undefined,
          };

          status.ip_info = enrichedIpInfo;
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
