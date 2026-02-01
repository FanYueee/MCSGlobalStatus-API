import dns from 'dns';
import { promisify } from 'util';
import { SrvRecord, DnsRecord } from '../types/index.js';

const resolveSrv = promisify(dns.resolveSrv);
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);
const resolveCname = promisify(dns.resolveCname);

// DNS timeout configuration
const DNS_TIMEOUT = 3000; // 3 seconds

// Helper function to add timeout to promises (handles both timeout AND rejection)
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback), // Return fallback on error
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

// IPv4 regex
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

// IPv6 regex (simplified, covers most common formats)
const IPV6_REGEX = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^::1$|^::$/;

export async function resolveSrvRecord(host: string): Promise<SrvRecord | null> {
  try {
    const records = await withTimeout(resolveSrv(`_minecraft._tcp.${host}`), DNS_TIMEOUT, []);
    if (records && records.length > 0) {
      const record = records[0];
      return {
        target: record.name,
        port: record.port,
      };
    }
  } catch {
    // SRV record not found, this is normal
  }
  return null;
}

export async function resolveIp(host: string): Promise<string | null> {
  // Check if already an IPv4 address
  if (IPV4_REGEX.test(host)) {
    return host;
  }

  // Check if already an IPv6 address
  if (IPV6_REGEX.test(host)) {
    return host;
  }

  // Query A and AAAA in parallel to reduce wait time
  const [ipv4Addresses, ipv6Addresses] = await Promise.all([
    withTimeout(resolve4(host), DNS_TIMEOUT, []),
    withTimeout(resolve6(host), DNS_TIMEOUT, [])
  ]);

  // Prefer IPv4
  if (ipv4Addresses && ipv4Addresses.length > 0) {
    return ipv4Addresses[0];
  }

  // Fall back to IPv6
  if (ipv6Addresses && ipv6Addresses.length > 0) {
    return ipv6Addresses[0];
  }

  return null;
}

export function parseAddress(address: string): { host: string; port: number } {
  // Handle IPv6 format: [ipv6]:port or [ipv6]
  if (address.startsWith('[')) {
    const closeBracket = address.indexOf(']');
    if (closeBracket !== -1) {
      const host = address.substring(1, closeBracket);
      const portPart = address.substring(closeBracket + 1);
      if (portPart.startsWith(':')) {
        const port = parseInt(portPart.substring(1), 10);
        return { host, port: isNaN(port) ? 25565 : port };
      }
      return { host, port: 25565 };
    }
  }

  // Handle IPv4 format: host:port or just host
  const lastColon = address.lastIndexOf(':');

  // Check if this might be an IPv6 address without brackets (multiple colons)
  const colonCount = (address.match(/:/g) || []).length;
  if (colonCount > 1) {
    // This is likely an IPv6 address without port
    return { host: address, port: 25565 };
  }

  // Standard IPv4 or hostname with optional port
  if (lastColon !== -1) {
    const host = address.substring(0, lastColon);
    const port = parseInt(address.substring(lastColon + 1), 10);
    return { host, port: isNaN(port) ? 25565 : port };
  }

  return { host: address, port: 25565 };
}

export function isIPv6(ip: string): boolean {
  return IPV6_REGEX.test(ip);
}

export function isIPv4(ip: string): boolean {
  return IPV4_REGEX.test(ip);
}

export async function collectDnsRecords(host: string, srvRecord?: SrvRecord | null): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  const resolved = new Set<string>(); // Prevent infinite loops

  // Skip if already an IP address
  if (IPV4_REGEX.test(host) || IPV6_REGEX.test(host)) {
    return records;
  }

  // Add SRV record if provided
  if (srvRecord) {
    records.push({
      hostname: `_minecraft._tcp.${host}`,
      type: 'SRV',
      data: `1 1 ${srvRecord.port} ${srvRecord.target}`,
    });

    // Recursively resolve the SRV target
    await resolveHostRecords(srvRecord.target, records, resolved);
  }

  // Recursively resolve the original host
  await resolveHostRecords(host, records, resolved);

  return records;
}

async function resolveHostRecords(host: string, records: DnsRecord[], resolved: Set<string>): Promise<void> {
  // Skip if already resolved or is an IP address
  if (resolved.has(host) || IPV4_REGEX.test(host) || IPV6_REGEX.test(host)) {
    return;
  }
  resolved.add(host);

  // Try CNAME record first
  try {
    const cnames = await withTimeout(resolveCname(host), DNS_TIMEOUT, []);
    if (cnames && cnames.length > 0) {
      const cnameTarget = cnames[0];
      records.push({
        hostname: host,
        type: 'CNAME',
        data: cnameTarget,
      });
      // Recursively resolve the CNAME target
      await resolveHostRecords(cnameTarget, records, resolved);
      return; // CNAME exists, don't look for A/AAAA on this hostname
    }
  } catch {
    // CNAME not found, continue to A/AAAA
  }

  // Try A record - add ALL records
  try {
    const aRecords = await withTimeout(resolve4(host), DNS_TIMEOUT, []);
    if (aRecords && aRecords.length > 0) {
      for (const ip of aRecords) {
        records.push({
          hostname: host,
          type: 'A',
          data: ip,
        });
      }
    }
  } catch {
    // A record not found
  }

  // Try AAAA record - add ALL records
  try {
    const aaaaRecords = await withTimeout(resolve6(host), DNS_TIMEOUT, []);
    if (aaaaRecords && aaaaRecords.length > 0) {
      for (const ip of aaaaRecords) {
        records.push({
          hostname: host,
          type: 'AAAA',
          data: ip,
        });
      }
    }
  } catch {
    // AAAA record not found
  }
}
