import { AsnInfo, LocationInfo } from '../types/index.js';
import maxmind, { CityResponse, AsnResponse, Reader } from 'maxmind';
import path from 'path';
import fs from 'fs';

let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;

const GEOIP_DIR = process.env.GEOIP_DIR || './data/geoip';

export async function initGeoIP(): Promise<boolean> {
  try {
    const cityPath = path.join(GEOIP_DIR, 'GeoLite2-City.mmdb');
    const asnPath = path.join(GEOIP_DIR, 'GeoLite2-ASN.mmdb');

    if (fs.existsSync(cityPath)) {
      cityReader = await maxmind.open<CityResponse>(cityPath);
    }

    if (fs.existsSync(asnPath)) {
      asnReader = await maxmind.open<AsnResponse>(asnPath);
    }

    return cityReader !== null || asnReader !== null;
  } catch (err) {
    console.warn('GeoIP initialization failed:', err);
    return false;
  }
}

export function lookupLocation(ip: string): LocationInfo | null {
  if (!cityReader) return null;

  try {
    const result = cityReader.get(ip);
    if (!result) return null;

    return {
      country_code: result.country?.iso_code || '',
      country: result.country?.names?.en || '',
      city: result.city?.names?.en,
      latitude: result.location?.latitude,
      longitude: result.location?.longitude,
    };
  } catch {
    return null;
  }
}

export function lookupAsn(ip: string): AsnInfo | null {
  if (!asnReader) return null;

  try {
    const result = asnReader.get(ip);
    if (!result) return null;

    return {
      number: result.autonomous_system_number || 0,
      org: result.autonomous_system_organization || '',
    };
  } catch {
    return null;
  }
}
