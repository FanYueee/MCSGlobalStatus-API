import dns from 'dns';
import { promisify } from 'util';
import { SrvRecord } from '../types/index.js';

const resolveSrv = promisify(dns.resolveSrv);
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

// IPv4 regex
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

// IPv6 regex (simplified, covers most common formats)
const IPV6_REGEX = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^::1$|^::$/;

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
  // Check if already an IPv4 address
  if (IPV4_REGEX.test(host)) {
    return host;
  }

  // Check if already an IPv6 address
  if (IPV6_REGEX.test(host)) {
    return host;
  }

  // Try to resolve hostname
  try {
    const addresses = await resolve4(host);
    if (addresses && addresses.length > 0) {
      return addresses[0];
    }
  } catch {
    // IPv4 resolution failed, try IPv6
  }

  try {
    const addresses = await resolve6(host);
    if (addresses && addresses.length > 0) {
      return addresses[0];
    }
  } catch {
    // DNS resolution failed
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
