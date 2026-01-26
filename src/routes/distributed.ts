import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { probeManager } from '../websocket/probeManager.js';
import { parseAddress } from '../services/dns.js';
import { DistributedResult, NodeResult } from '../types/index.js';

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

      const probes = probeManager.getAllProbes();
      if (probes.length === 0) {
        reply.status(503);
        return { error: 'No probe nodes available' };
      }

      const { host, port } = parseAddress(server);
      const protocol = type || 'java';

      const results = await probeManager.broadcastTask(host, port, protocol);

      const nodes: Record<string, NodeResult> = {};
      for (const [probeId, result] of results) {
        const probe = probeManager.getProbe(probeId);
        nodes[probeId] = {
          node_region: probe?.region || 'Unknown',
          status: result.data || {
            online: false,
            host,
            port,
            error: result.error,
          },
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
