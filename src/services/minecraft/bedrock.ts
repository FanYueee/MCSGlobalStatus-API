import dgram from 'dgram';
import { ServerStatus, VersionInfo, PlayersInfo } from '../../types/index.js';
import { parseMotd } from './motd.js';

const UNCONNECTED_PING = 0x01;
const UNCONNECTED_PONG = 0x1c;
const OFFLINE_MESSAGE_ID = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);

const MAX_RETRIES = 0; // No retry for UDP - if no response, retry won't help
const RETRY_DELAY = 500;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pingBedrockServer(
  host: string,
  port: number,
  timeout: number = 3000
): Promise<ServerStatus> {
  let lastResult: ServerStatus | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY);
    }

    const result = await pingBedrockServerOnce(host, port, timeout);

    if (result.online) {
      return result;
    }

    lastResult = result;

    // Only retry on timeout or network errors
    if (result.error !== 'timeout' && !result.error?.includes('ECONNRESET')) {
      return result;
    }
  }

  return lastResult!;
}

async function pingBedrockServerOnce(
  host: string,
  port: number,
  timeout: number
): Promise<ServerStatus> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.close();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({ online: false, host, port, error: 'timeout' });
    }, timeout);

    socket.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({ online: false, host, port, error: err.message });
    });

    socket.on('message', (msg) => {
      clearTimeout(timer);
      const result = parseUnconnectedPong(msg, host, port);
      cleanup();
      resolve(result);
    });

    // Use connect() to create a "connected" UDP socket
    // This allows us to receive ICMP port unreachable errors
    socket.connect(port, host, () => {
      const pingPacket = createUnconnectedPing();
      socket.send(pingPacket);
    });
  });
}

function createUnconnectedPing(): Buffer {
  const timestamp = BigInt(Date.now());
  // Use a smaller random value that fits in signed int64
  const clientGuid = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

  const buffer = Buffer.alloc(1 + 8 + 16 + 8);
  let offset = 0;

  buffer.writeUInt8(UNCONNECTED_PING, offset);
  offset += 1;

  buffer.writeBigInt64BE(timestamp, offset);
  offset += 8;

  OFFLINE_MESSAGE_ID.copy(buffer, offset);
  offset += 16;

  buffer.writeBigInt64BE(clientGuid, offset);

  return buffer;
}

function parseUnconnectedPong(
  buffer: Buffer,
  host: string,
  port: number
): ServerStatus {
  if (buffer.length < 35 || buffer[0] !== UNCONNECTED_PONG) {
    return { online: false, host, port, error: 'Invalid pong response' };
  }

  let offset = 1; // Skip packet ID
  offset += 8; // Skip timestamp
  offset += 8; // Skip server GUID
  offset += 16; // Skip magic

  const stringLength = buffer.readUInt16BE(offset);
  offset += 2;

  if (buffer.length < offset + stringLength) {
    return { online: false, host, port, error: 'Truncated response' };
  }

  const serverInfo = buffer.subarray(offset, offset + stringLength).toString('utf8');
  return parseServerInfo(serverInfo, host, port);
}

function parseServerInfo(
  info: string,
  host: string,
  port: number
): ServerStatus {
  // Format: Edition;MOTD;Protocol;Version;Players;MaxPlayers;ServerID;SubMOTD;Gamemode;...
  const parts = info.split(';');

  if (parts.length < 6) {
    return { online: false, host, port, error: 'Invalid server info format' };
  }

  const [edition, motdRaw, protocolStr, versionName, playersStr, maxPlayersStr] = parts;

  const version: VersionInfo = {
    name: `${edition} ${versionName}`,
    name_clean: versionName,
    protocol: parseInt(protocolStr, 10) || 0,
  };

  const players: PlayersInfo = {
    online: parseInt(playersStr, 10) || 0,
    max: parseInt(maxPlayersStr, 10) || 0,
  };

  const motd = parseMotd(motdRaw);

  return {
    online: true,
    host,
    port,
    version,
    players,
    motd,
  };
}
