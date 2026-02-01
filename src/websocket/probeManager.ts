import { WebSocket } from 'ws';
import { ProbeNode, PingTask, PingResult } from '../types/index.js';
import { randomUUID } from 'crypto';

class ProbeManager {
  private probes: Map<string, ProbeNode> = new Map();
  private pendingTasks: Map<string, {
    resolve: (result: PingResult) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  register(id: string, region: string, socket: WebSocket): void {
    const existing = this.probes.get(id);
    if (existing) {
      existing.socket.close();
    }

    this.probes.set(id, {
      id,
      region,
      socket: socket as unknown as globalThis.WebSocket,
      lastPing: Date.now(),
    });

    console.log(`Probe registered: ${id} (${region})`);
  }

  unregister(id: string): void {
    this.probes.delete(id);
    console.log(`Probe unregistered: ${id}`);
  }

  getProbe(id: string): ProbeNode | undefined {
    return this.probes.get(id);
  }

  getAllProbes(): ProbeNode[] {
    return Array.from(this.probes.values());
  }

  getProbeCount(): number {
    return this.probes.size;
  }

  handleMessage(probeId: string, message: string): void {
    try {
      const result = JSON.parse(message) as PingResult;
      const pending = this.pendingTasks.get(result.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(result);
        this.pendingTasks.delete(result.id);
      }
    } catch (err) {
      console.error(`Invalid message from probe ${probeId}:`, err);
    }
  }

  async sendTask(
    probeId: string,
    target: string,
    port: number,
    protocol: 'java' | 'bedrock',
    timeout: number = 6000
  ): Promise<PingResult> {
    const probe = this.probes.get(probeId);
    if (!probe) {
      return {
        id: '',
        success: false,
        error: `Probe ${probeId} not found`,
      };
    }

    const taskId = randomUUID();
    const task: PingTask = {
      id: taskId,
      type: 'ping',
      target,
      port,
      protocol,
    };

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        resolve({
          id: taskId,
          success: false,
          error: 'Task timeout',
        });
      }, timeout);

      this.pendingTasks.set(taskId, {
        resolve,
        timeout: timeoutHandle,
      });

      (probe.socket as unknown as WebSocket).send(JSON.stringify(task));
    });
  }

  async broadcastTask(
    target: string,
    port: number,
    protocol: 'java' | 'bedrock'
  ): Promise<Map<string, PingResult>> {
    const results = new Map<string, PingResult>();
    const probes = this.getAllProbes();

    if (probes.length === 0) {
      return results;
    }

    const promises = probes.map(async (probe) => {
      const result = await this.sendTask(probe.id, target, port, protocol);
      results.set(probe.id, result);
    });

    await Promise.all(promises);
    return results;
  }
}

export const probeManager = new ProbeManager();
