function normalizeIp(ip: string): string {
  const trimmed = ip.trim();

  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }

  return trimmed;
}

export function parseIpAllowlist(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return [...new Set(
    rawValue
      .split(',')
      .map((ip) => normalizeIp(ip))
      .filter((ip) => ip.length > 0)
  )];
}

export function isIpAllowed(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return false;
  }

  const normalizedIp = normalizeIp(ip);
  if (allowlist.includes(normalizedIp)) {
    return true;
  }

  // Treat IPv4 localhost and IPv6 localhost as equivalent for local administration.
  if (normalizedIp === '127.0.0.1' && allowlist.includes('::1')) {
    return true;
  }

  if (normalizedIp === '::1' && allowlist.includes('127.0.0.1')) {
    return true;
  }

  return false;
}

export function formatIpForLog(ip: string): string {
  return normalizeIp(ip);
}
