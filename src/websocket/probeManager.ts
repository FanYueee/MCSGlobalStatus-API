import { WebSocket } from 'ws';
import { ProbeNode, PingTask, PingResult, ProbeHealthSummary } from '../types/index.js';
import { randomUUID } from 'crypto';

class ProbeManager {
  private probes: Map<string, ProbeNode> = new Map();
  private pendingTasks: Map<string, {
    probeId: string;
    resolve: (result: PingResult) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  private resolvePendingTask(taskId: string, result: PingResult): void {
    const pending = this.pendingTasks.get(taskId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingTasks.delete(taskId);
    pending.resolve(result);
  }

  private failPendingTasksForProbe(probeId: string, error: string): void {
    for (const [taskId, pending] of this.pendingTasks.entries()) {
      if (pending.probeId !== probeId) {
        continue;
      }

      this.resolvePendingTask(taskId, {
        id: taskId,
        success: false,
        error,
      });
    }
  }

  private markProbeActivity(probeId: string): void {
    const probe = this.probes.get(probeId);
    if (!probe) {
      return;
    }

    probe.lastPing = Date.now();
  }

  register(id: string, region: string, socket: WebSocket): void {
    const existing = this.probes.get(id);
    const normalizedSocket = socket as unknown as globalThis.WebSocket;

    this.probes.set(id, {
      id,
      region,
      socket: normalizedSocket,
      lastPing: Date.now(),
    });

    // Close the replaced socket after swapping the map entry so the old
    // connection's close event cannot unregister the fresh connection.
    if (existing && existing.socket !== normalizedSocket) {
      (existing.socket as unknown as WebSocket).close();
    }

    console.log(`Probe registered: ${id} (${region})`);
  }

  unregister(id: string, socket?: WebSocket): void {
    const existing = this.probes.get(id);
    if (!existing) {
      return;
    }

    if (socket && (existing.socket as unknown as WebSocket) !== socket) {
      return;
    }

    this.probes.delete(id);
    this.failPendingTasksForProbe(id, `Probe ${id} disconnected`);
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

  getPendingTaskCount(): number {
    return this.pendingTasks.size;
  }

  getProbeHealthSummaries(): ProbeHealthSummary[] {
    const now = Date.now();

    return this.getAllProbes().map((probe) => {
      const socket = probe.socket as unknown as WebSocket;
      let pendingTasks = 0;

      for (const pending of this.pendingTasks.values()) {
        if (pending.probeId === probe.id) {
          pendingTasks++;
        }
      }

      return {
        id: probe.id,
        region: probe.region,
        connected: socket.readyState === WebSocket.OPEN,
        last_seen_at: new Date(probe.lastPing).toISOString(),
        last_seen_ago_ms: Math.max(0, now - probe.lastPing),
        pending_tasks: pendingTasks,
      };
    });
  }

  handleMessage(probeId: string, message: string): void {
    try {
      this.markProbeActivity(probeId);
      const result = JSON.parse(message) as PingResult;
      this.resolvePendingTask(result.id, result);
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

    const socket = probe.socket as unknown as WebSocket;
    if (socket.readyState !== WebSocket.OPEN) {
      return {
        id: '',
        success: false,
        error: `Probe ${probeId} is not connected`,
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
        this.resolvePendingTask(taskId, {
          id: taskId,
          success: false,
          error: 'Task timeout',
        });
      }, timeout);

      this.pendingTasks.set(taskId, {
        probeId,
        resolve,
        timeout: timeoutHandle,
      });

      try {
        socket.send(JSON.stringify(task), (err) => {
          if (err) {
            this.resolvePendingTask(taskId, {
              id: taskId,
              success: false,
              error: `Failed to send task to probe ${probeId}: ${err.message}`,
            });
          }
        });
      } catch (err) {
        this.resolvePendingTask(taskId, {
          id: taskId,
          success: false,
          error: err instanceof Error
            ? `Failed to send task to probe ${probeId}: ${err.message}`
            : `Failed to send task to probe ${probeId}`,
        });
      }
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
