import { isIP } from 'net';

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
      .map((entry) => normalizeIp(entry))
      .filter((entry) => entry.length > 0)
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

  return allowlist.some((entry) => matchesCidr(normalizedIp, entry));
}

function matchesCidr(ip: string, entry: string): boolean {
  if (!entry.includes('/')) {
    return false;
  }

  const [networkRaw, prefixRaw] = entry.split('/');
  const network = normalizeIp(networkRaw);
  const prefix = Number.parseInt(prefixRaw, 10);
  if (!Number.isFinite(prefix)) {
    return false;
  }

  const ipBytes = parseIpBytes(ip);
  const networkBytes = parseIpBytes(network);
  if (!ipBytes || !networkBytes || ipBytes.length !== networkBytes.length) {
    return false;
  }

  const maxPrefix = ipBytes.length * 8;
  if (prefix < 0 || prefix > maxPrefix) {
    return false;
  }

  const fullBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;

  for (let index = 0; index < fullBytes; index += 1) {
    if (ipBytes[index] !== networkBytes[index]) {
      return false;
    }
  }

  if (remainingBits === 0) {
    return true;
  }

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (ipBytes[fullBytes] & mask) === (networkBytes[fullBytes] & mask);
}

function parseIpBytes(ip: string): number[] | null {
  const normalized = normalizeIp(ip);
  const version = isIP(normalized);
  if (version === 4) {
    return normalized.split('.').map((part) => Number.parseInt(part, 10));
  }

  if (version === 6) {
    return parseIpv6Bytes(normalized);
  }

  return null;
}

function parseIpv6Bytes(ip: string): number[] | null {
  const [headRaw, tailRaw] = ip.split('::');
  if (ip.split('::').length > 2) {
    return null;
  }

  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : [];

  const expanded: string[] = [];
  for (const part of head) {
    expanded.push(part);
  }

  const missingBlocks = 8 - (head.length + tail.length);
  if (tailRaw !== undefined) {
    for (let index = 0; index < missingBlocks; index += 1) {
      expanded.push('0');
    }
  }

  for (const part of tail) {
    expanded.push(part);
  }

  if (tailRaw === undefined && expanded.length !== 8) {
    return null;
  }

  if (expanded.length !== 8) {
    return null;
  }

  const bytes: number[] = [];
  for (const block of expanded) {
    const value = Number.parseInt(block, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) {
      return null;
    }
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  return bytes;
}

export function formatIpForLog(ip: string): string {
  return normalizeIp(ip);
}
