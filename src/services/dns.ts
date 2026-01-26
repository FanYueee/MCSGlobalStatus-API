import dns from 'dns';
import { promisify } from 'util';
import { SrvRecord } from '../types/index.js';

const resolveSrv = promisify(dns.resolveSrv);
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

export async function resolveSrvRecord(host: string): Promise<SrvRecord | null> {
  try {
    const records = await resolveSrv(`_minecraft._tcp.${host}`);
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
  // Check if already an IP address
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return host;
  }

  try {
    const addresses = await resolve4(host);
    if (addresses && addresses.length > 0) {
      return addresses[0];
    }
  } catch {
    // Try IPv6
    try {
      const addresses = await resolve6(host);
      if (addresses && addresses.length > 0) {
        return addresses[0];
      }
    } catch {
      // DNS resolution failed
    }
  }
  return null;
}

export function parseAddress(address: string): { host: string; port: number } {
  const parts = address.split(':');
  const host = parts[0];
  const port = parts.length > 1 ? parseInt(parts[1], 10) : 25565;
  return { host, port: isNaN(port) ? 25565 : port };
}
