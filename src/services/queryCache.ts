import { parseAddress } from './dns.js';
import type { ProbeNode } from '../types/index.js';

export const QUERY_CACHE_TTL_MS = 5 * 60 * 1000;
export const QUERY_CACHE_STATUS_HEADER = 'X-MCS-Cache-Status';
export const QUERY_CACHE_BYPASS_HEADER = 'x-mcs-cache-bypass-token';

export type QueryCacheStatus = 'HIT' | 'MISS' | 'BYPASS';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface CacheBypassDecision {
  requested: boolean;
  bypass: boolean;
  authorized: boolean;
}

export class QueryCache {
  private entries: Map<string, CacheEntry> = new Map();
  private pending: Map<string, Promise<unknown>> = new Map();
  private versions: Map<string, number> = new Map();

  constructor(private readonly ttlMs: number = QUERY_CACHE_TTL_MS) {}

  getTtlMs(): number {
    return this.ttlMs;
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.versions.clear();
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    options: { bypass?: boolean } = {}
  ): Promise<{ status: QueryCacheStatus; value: T }> {
    const bypass = options.bypass === true;
    const now = Date.now();

    this.evictExpired(now);

    if (!bypass) {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > now) {
        return {
          status: 'HIT',
          value: cloneCacheValue(cached.value as T),
        };
      }

      const pending = this.pending.get(key);
      if (pending) {
        return {
          status: 'HIT',
          value: cloneCacheValue(await pending as T),
        };
      }
    }

    const version = (this.versions.get(key) || 0) + 1;
    this.versions.set(key, version);

    const pendingLoad = (async () => {
      const loaded = await loader();
      const cachedValue = cloneCacheValue(loaded);

      if (this.versions.get(key) === version) {
        this.entries.set(key, {
          value: cachedValue,
          expiresAt: Date.now() + this.ttlMs,
        });
      }

      return cloneCacheValue(cachedValue);
    })();

    this.pending.set(key, pendingLoad);

    try {
      return {
        status: bypass ? 'BYPASS' : 'MISS',
        value: await pendingLoad,
      };
    } finally {
      if (this.pending.get(key) === pendingLoad) {
        this.pending.delete(key);
      }
    }
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export const queryCache = new QueryCache();

export function normalizeCacheTarget(
  address: string,
  type: 'java' | 'bedrock'
): { host: string; port: number } {
  const { host, port } = parseAddress(address.trim());
  return {
    host: host.trim().toLowerCase(),
    port: normalizeCachePort(port, type),
  };
}

export function buildStatusCacheKey(
  address: string,
  type: 'java' | 'bedrock'
): string {
  const target = normalizeCacheTarget(address, type);
  return `status:${type}:${target.host}:${target.port}`;
}

export function buildDistributedCacheKey(
  address: string,
  type: 'java' | 'bedrock',
  probes: Pick<ProbeNode, 'id' | 'region'>[]
): string {
  const target = normalizeCacheTarget(address, type);
  return `distributed:${type}:${target.host}:${target.port}:${buildProbeFingerprint(probes)}`;
}

export function buildProbeFingerprint(
  probes: Pick<ProbeNode, 'id' | 'region'>[]
): string {
  if (probes.length === 0) {
    return 'none';
  }

  return probes
    .map((probe) => `${probe.id}@${probe.region}`)
    .sort()
    .join(',');
}

export function evaluateCacheBypass(
  fresh: string | undefined,
  providedToken: string | string[] | undefined,
  configuredToken: string | undefined = process.env.CACHE_BYPASS_TOKEN
): CacheBypassDecision {
  const requested = isTruthyFlag(fresh);
  if (!requested) {
    return {
      requested: false,
      bypass: false,
      authorized: false,
    };
  }

  const token = Array.isArray(providedToken) ? providedToken[0] : providedToken;
  const authorized = Boolean(configuredToken && token && token === configuredToken);

  return {
    requested: true,
    bypass: authorized,
    authorized,
  };
}

function normalizeCachePort(port: number, type: 'java' | 'bedrock'): number {
  if (type === 'bedrock' && port === 25565) {
    return 19132;
  }

  return port;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function cloneCacheValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
