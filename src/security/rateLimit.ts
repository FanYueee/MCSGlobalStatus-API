import { FastifyReply, FastifyRequest } from 'fastify';

interface RateLimitState {
  count: number;
  resetAt: number;
}

interface RateLimitScopeConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

const DEFAULT_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const DEFAULT_STATUS_MAX = parsePositiveInt(process.env.RATE_LIMIT_STATUS_MAX, 60);
const DEFAULT_DISTRIBUTED_MAX = parsePositiveInt(process.env.RATE_LIMIT_DISTRIBUTED_MAX, 20);
const DEFAULT_WEBSOCKET_MAX = parsePositiveInt(process.env.RATE_LIMIT_WEBSOCKET_MAX, 30);

const scopeConfigs: Record<string, RateLimitScopeConfig> = {
  status: {
    windowMs: DEFAULT_WINDOW_MS,
    maxRequests: DEFAULT_STATUS_MAX,
  },
  distributed: {
    windowMs: DEFAULT_WINDOW_MS,
    maxRequests: DEFAULT_DISTRIBUTED_MAX,
  },
  websocket: {
    windowMs: DEFAULT_WINDOW_MS,
    maxRequests: DEFAULT_WEBSOCKET_MAX,
  },
};

const rateLimitStore = new Map<string, RateLimitState>();
let operationCount = 0;

export function createRateLimitHook(scope: keyof typeof scopeConfigs) {
  const config = scopeConfigs[scope];

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.maxRequests <= 0 || config.windowMs <= 0) {
      return;
    }

    const decision = consumeRateLimit(scope, request.ip, config);
    applyRateLimitHeaders(reply, decision);

    if (decision.allowed) {
      return;
    }

    reply.code(429).send({
      error: 'Rate limit exceeded',
      scope,
      retry_after_seconds: decision.retryAfterSeconds,
    });
  };
}

function consumeRateLimit(scope: string, ip: string, config: RateLimitScopeConfig): RateLimitDecision {
  const now = Date.now();
  const key = `${scope}:${ip}`;
  const current = rateLimitStore.get(key);

  if (!current || current.resetAt <= now) {
    const resetAt = now + config.windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    cleanupExpiredEntries(now);

    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: Math.max(config.maxRequests - 1, 0),
      resetAt,
      retryAfterSeconds: Math.ceil(config.windowMs / 1000),
    };
  }

  current.count += 1;
  cleanupExpiredEntries(now);

  const allowed = current.count <= config.maxRequests;
  const remaining = allowed
    ? Math.max(config.maxRequests - current.count, 0)
    : 0;

  return {
    allowed,
    limit: config.maxRequests,
    remaining,
    resetAt: current.resetAt,
    retryAfterSeconds: Math.max(Math.ceil((current.resetAt - now) / 1000), 1),
  };
}

function applyRateLimitHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
  reply.header('X-RateLimit-Limit', decision.limit);
  reply.header('X-RateLimit-Remaining', decision.remaining);
  reply.header('X-RateLimit-Reset', Math.ceil(decision.resetAt / 1000));
  reply.header('Retry-After', decision.retryAfterSeconds);
}

function cleanupExpiredEntries(now: number): void {
  operationCount += 1;

  if (operationCount % 200 !== 0) {
    return;
  }

  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
