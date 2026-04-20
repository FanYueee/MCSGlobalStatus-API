import { parseAddress } from './dns.js';
import type { ProbeNode } from '../types/index.js';

export const QUERY_CACHE_TTL_MS = 5 * 60 * 1000;
export const QUERY_CACHE_STATUS_HEADER = 'X-MCS-Cache-Status';
export const QUERY_CACHE_BYPASS_HEADER = 'x-mcs-cache-bypass-token';
export const QUERY_CACHE_CREATED_AT_HEADER = 'X-MCS-Cache-Created-At';
export const QUERY_CACHE_CREATED_AT_DISPLAY_HEADER = 'X-MCS-Cache-Created-At-Display';
export const QUERY_CACHE_EXPIRES_AT_HEADER = 'X-MCS-Cache-Expires-At';
export const QUERY_CACHE_EXPIRES_AT_DISPLAY_HEADER = 'X-MCS-Cache-Expires-At-Display';

export type QueryCacheStatus = 'HIT' | 'MISS' | 'BYPASS';

interface CacheEntry {
  value: unknown;
  createdAt: number;
  expiresAt: number;
}

interface CacheSnapshot {
  value: unknown;
  createdAt: number;
  expiresAt: number;
}

export interface CacheBypassDecision {
  requested: boolean;
  bypass: boolean;
  authorized: boolean;
}

export interface QueryCacheResult<T> {
  status: QueryCacheStatus;
  value: T;
  cachedAt: string;
  cachedAtDisplay: string;
  expiresAt: string;
  expiresAtDisplay: string;
}

export class QueryCache {
  private entries: Map<string, CacheEntry> = new Map();
  private pending: Map<string, Promise<CacheSnapshot>> = new Map();
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
  ): Promise<QueryCacheResult<T>> {
    const bypass = options.bypass === true;
    const now = Date.now();

    this.evictExpired(now);

    if (!bypass) {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > now) {
        return {
          status: 'HIT',
          value: cloneCacheValue(cached.value as T),
          ...buildCacheTimeMetadata(cached.createdAt, cached.expiresAt),
        };
      }

      const pending = this.pending.get(key);
      if (pending) {
        const snapshot = await pending;
        return {
          status: 'HIT',
          value: cloneCacheValue(snapshot.value as T),
          ...buildCacheTimeMetadata(snapshot.createdAt, snapshot.expiresAt),
        };
      }
    }

    const version = (this.versions.get(key) || 0) + 1;
    this.versions.set(key, version);

    const pendingLoad = (async () => {
      const loaded = await loader();
      const cachedAt = Date.now();
      const cachedValue = cloneCacheValue(loaded);
      const snapshot: CacheSnapshot = {
        value: cachedValue,
        createdAt: cachedAt,
        expiresAt: cachedAt + this.ttlMs,
      };

      if (this.versions.get(key) === version) {
        this.entries.set(key, {
          ...snapshot,
        });
      }

      return snapshot;
    })();

    this.pending.set(key, pendingLoad);

    try {
      const snapshot = await pendingLoad;
      return {
        status: bypass ? 'BYPASS' : 'MISS',
        value: cloneCacheValue(snapshot.value as T),
        ...buildCacheTimeMetadata(snapshot.createdAt, snapshot.expiresAt),
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

function buildCacheTimeMetadata(createdAt: number, expiresAt: number): Omit<QueryCacheResult<unknown>, 'status' | 'value'> {
  return {
    cachedAt: new Date(createdAt).toISOString(),
    cachedAtDisplay: formatApiHostTimestamp(createdAt),
    expiresAt: new Date(expiresAt).toISOString(),
    expiresAtDisplay: formatApiHostTimestamp(expiresAt),
  };
}

function formatApiHostTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, '0');
  const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC${sign}${offsetHours}:${offsetRemainderMinutes}`;
}
