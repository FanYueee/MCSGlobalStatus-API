import { FastifyInstance } from 'fastify';
import { probeManager } from './probeManager.js';
import { readFileSync, watchFile, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBES_CONFIG_PATH = join(__dirname, '../../probes.json');

// Store probe secrets in memory
let probeSecrets: Map<string, string> = new Map();

// Load secrets from config file
function loadProbeSecrets(): void {
  try {
    if (!existsSync(PROBES_CONFIG_PATH)) {
      console.warn('probes.json not found, using empty config');
      probeSecrets = new Map();
      return;
    }

    const content = readFileSync(PROBES_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as Record<string, string>;

    const newSecrets = new Map<string, string>();
    for (const [id, secret] of Object.entries(config)) {
      newSecrets.set(id, secret);
    }

    probeSecrets = newSecrets;
    console.log(`Loaded ${probeSecrets.size} probe secrets from config`);
  } catch (err) {
    console.error('Failed to load probes.json:', err);
  }
}

// Watch for config file changes (hot reload)
function watchProbeSecrets(): void {
  if (!existsSync(PROBES_CONFIG_PATH)) {
    return;
  }

  watchFile(PROBES_CONFIG_PATH, { interval: 1000 }, (curr, prev) => {
    if (curr.mtime !== prev.mtime) {
      console.log('probes.json changed, reloading...');
      loadProbeSecrets();
    }
  });
}

// Initialize on module load
loadProbeSecrets();
watchProbeSecrets();

function validateProbeAuth(probeId: string, authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix
  const expectedSecret = probeSecrets.get(probeId);

  if (!expectedSecret) {
    console.warn(`Unknown probe ID: ${probeId}`);
    return false;
  }

  return token === expectedSecret;
}

export async function setupWebSocket(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/stream', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    const region = url.searchParams.get('region');
    const auth = req.headers.authorization;

    if (!id || !region) {
      socket.close(4002, 'Missing id or region parameter');
      return;
    }

    // Validate authorization
    if (!validateProbeAuth(id, auth)) {
      console.warn(`Unauthorized probe connection attempt: ${id}`);
      socket.close(4001, 'Unauthorized');
      return;
    }

    probeManager.register(id, region, socket);

    socket.on('message', (data) => {
      probeManager.handleMessage(id, data.toString());
    });

    socket.on('close', () => {
      probeManager.unregister(id);
    });

    socket.on('error', (err) => {
      console.error(`WebSocket error for probe ${id}:`, err);
      probeManager.unregister(id);
    });
  });
}
