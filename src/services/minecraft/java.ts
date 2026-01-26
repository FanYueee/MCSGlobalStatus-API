import net from 'net';
import { ServerStatus, VersionInfo, PlayersInfo } from '../../types/index.js';
import { parseMotd } from './motd.js';

const PROTOCOL_VERSION = 767; // 1.21.1

export async function pingJavaServer(
  host: string,
  port: number,
  timeout: number = 5000,
  connectHost?: string // Optional: IP to connect to (for SRV/proxy scenarios)
): Promise<ServerStatus> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeout);

    socket.on('timeout', () => {
      cleanup();
      resolve({ online: false, host, port, error: 'timeout' });
    });

    socket.on('error', (err) => {
      cleanup();
      resolve({ online: false, host, port, error: err.message });
    });

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        const result = parseResponse(buffer, host, port);
        if (result) {
          cleanup();
          resolve(result);
        }
      } catch {
        // Need more data
      }
    });

    // Connect to connectHost (IP) but use original host in handshake
    const targetHost = connectHost || host;
    socket.connect(port, targetHost, () => {
      // Use original hostname in handshake (important for TCPShield/proxies)
      const handshake = createHandshakePacket(host, port);
      const statusRequest = createStatusRequestPacket();
      socket.write(handshake);
      socket.write(statusRequest);
    });
  });
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  while (true) {
    if ((value & ~0x7f) === 0) {
      bytes.push(value);
      break;
    }
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarInt(buffer: Buffer, offset: number): { value: number; length: number } {
  let value = 0;
  let length = 0;
  let currentByte: number;

  do {
    if (offset + length >= buffer.length) {
      throw new Error('VarInt too short');
    }
    currentByte = buffer[offset + length];
    value |= (currentByte & 0x7f) << (length * 7);
    length++;
    if (length > 5) {
      throw new Error('VarInt too long');
    }
  } while ((currentByte & 0x80) !== 0);

  return { value, length };
}

function createHandshakePacket(host: string, port: number): Buffer {
  const hostBuffer = Buffer.from(host, 'utf8');
  const data = Buffer.concat([
    writeVarInt(PROTOCOL_VERSION),
    writeVarInt(hostBuffer.length),
    hostBuffer,
    Buffer.from([port >> 8, port & 0xff]),
    writeVarInt(1), // Next state: Status
  ]);

  const packetId = writeVarInt(0x00);
  const packetLength = writeVarInt(packetId.length + data.length);

  return Buffer.concat([packetLength, packetId, data]);
}

function createStatusRequestPacket(): Buffer {
  const packetId = writeVarInt(0x00);
  const packetLength = writeVarInt(packetId.length);
  return Buffer.concat([packetLength, packetId]);
}

function parseResponse(
  buffer: Buffer,
  host: string,
  port: number
): ServerStatus | null {
  let offset = 0;

  // Read packet length
  const packetLengthResult = readVarInt(buffer, offset);
  offset += packetLengthResult.length;
  const packetLength = packetLengthResult.value;

  if (buffer.length < offset + packetLength) {
    return null; // Need more data
  }

  // Read packet ID
  const packetIdResult = readVarInt(buffer, offset);
  offset += packetIdResult.length;

  // Read JSON string length
  const jsonLengthResult = readVarInt(buffer, offset);
  offset += jsonLengthResult.length;
  const jsonLength = jsonLengthResult.value;

  if (buffer.length < offset + jsonLength) {
    return null; // Need more data
  }

  const jsonString = buffer.subarray(offset, offset + jsonLength).toString('utf8');

  try {
    const data = JSON.parse(jsonString);
    return parseStatusResponse(data, host, port);
  } catch {
    return { online: false, host, port, error: 'Invalid JSON response' };
  }
}

interface StatusResponse {
  version?: { name?: string; protocol?: number };
  players?: { max?: number; online?: number; sample?: Array<{ name: string; id: string }> };
  description?: string | { text?: string; extra?: unknown[] };
  favicon?: string;
}

function parseStatusResponse(
  data: StatusResponse,
  host: string,
  port: number
): ServerStatus {
  const version: VersionInfo | undefined = data.version
    ? {
        name: data.version.name || 'Unknown',
        name_clean: cleanVersionName(data.version.name || 'Unknown'),
        protocol: data.version.protocol || 0,
      }
    : undefined;

  const players: PlayersInfo | undefined = data.players
    ? {
        online: data.players.online || 0,
        max: data.players.max || 0,
        sample: data.players.sample,
      }
    : undefined;

  const motd = data.description ? parseMotd(data.description as string) : undefined;

  return {
    online: true,
    host,
    port,
    version,
    players,
    motd,
    favicon: data.favicon,
  };
}

function cleanVersionName(name: string): string {
  // Remove color codes and extract version number
  const cleaned = name.replace(/§[0-9a-fk-or]/gi, '');
  const match = cleaned.match(/\d+\.\d+(\.\d+)?/);
  return match ? match[0] : cleaned;
}
