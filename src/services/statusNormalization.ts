import {
  ServerStatus,
  VersionInfo,
  PlayersInfo,
  MotdInfo,
  IpInfo,
} from '../types/index.js';

export function normalizeServerStatus(status: ServerStatus): ServerStatus {
  const normalized: ServerStatus = { ...status };

  if (normalized.version) {
    normalized.version = normalizeVersionInfo(normalized.version);
  }

  if (normalized.players) {
    normalized.players = normalizePlayersInfo(normalized.players);
  }

  if (normalized.motd) {
    normalized.motd = normalizeMotdInfo(normalized.motd);
  }

  if (normalized.ip_info) {
    normalized.ip_info = normalizeIpInfo(normalized.ip_info);
  }

  if (normalized.error) {
    normalized.error = normalizeErrorMessage(normalized.error, normalized.host);
  }

  return normalized;
}

function normalizeVersionInfo(version: VersionInfo): VersionInfo {
  return {
    ...version,
    name_clean: normalizeVersionName(version.name_clean || version.name),
  };
}

function normalizePlayersInfo(players: PlayersInfo): PlayersInfo {
  const sample = players.sample?.filter(player => player.name && player.id) || undefined;

  return {
    ...players,
    sample: sample && sample.length > 0 ? sample : undefined,
  };
}

function normalizeMotdInfo(motd: MotdInfo): MotdInfo {
  return {
    ...motd,
    html: normalizeInlineStyleHtml(motd.html),
  };
}

function normalizeIpInfo(ipInfo: IpInfo): IpInfo {
  const uniqueIps = [...new Set([
    ...(ipInfo.ips || []),
    ...(ipInfo.ip ? [ipInfo.ip] : []),
  ])];

  return {
    ...ipInfo,
    ips: uniqueIps.length > 1 ? uniqueIps : undefined,
  };
}

function normalizeVersionName(value: string): string {
  const trimmed = value.trim();
  const versionMatch = trimmed.match(/\d+\.\d+(?:\.\d+)?/);

  if (versionMatch) {
    return versionMatch[0];
  }

  return trimmed.replace(/[.,;:]+$/g, '').trim();
}

function normalizeInlineStyleHtml(html: string): string {
  return html.replace(/style="([^"]*)"/g, (_match, styleValue: string) => {
    const normalizedStyle = styleValue
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => part.replace(/\s*:\s*/g, ': '))
      .join('; ');

    return normalizedStyle ? `style="${normalizedStyle}"` : 'style=""';
  });
}

function normalizeErrorMessage(error: string, host: string): string {
  if (error === 'DNS resolution failed') {
    return `DNS resolution failed for ${host}`;
  }

  if (error === 'DNS resolution timeout') {
    return `DNS resolution timeout for ${host}`;
  }

  return error;
}
