import { WebSocket } from 'ws';
import {
  ProbeNode,
  PingTask,
  PingResult,
  ProbeHealthSummary,
  ProbeTaskStats,
  ProbeObservabilitySummary,
  RecentProbeError,
} from '../types/index.js';
import { randomUUID } from 'crypto';

class ProbeManager {
  private static readonly RECENT_ERROR_LIMIT = 20;
  private static readonly RECENT_LATENCY_LIMIT = 10;

  private probes: Map<string, ProbeNode> = new Map();
  private probeStats: Map<string, ProbeTaskStats> = new Map();
  private pendingTasks: Map<string, {
    probeId: string;
    startedAt: number;
    resolve: (result: PingResult) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private totalTasksSent = 0;
  private totalTasksSucceeded = 0;
  private totalTasksFailed = 0;
  private totalTasksTimedOut = 0;
  private totalProbeDisconnects = 0;
  private recentErrors: RecentProbeError[] = [];
  private errorCounts: Map<string, number> = new Map();

  private createDefaultStats(): ProbeTaskStats {
    return {
      tasks_sent: 0,
      tasks_succeeded: 0,
      tasks_failed: 0,
      tasks_timed_out: 0,
      recent_latencies_ms: [],
      success_rate: 0,
      timeout_ratio: 0,
      disconnects: 0,
    };
  }

  private getOrCreateProbeStats(probeId: string): ProbeTaskStats {
    const existing = this.probeStats.get(probeId);
    if (existing) {
      return existing;
    }

    const created = this.createDefaultStats();
    this.probeStats.set(probeId, created);
    return created;
  }

  private resolvePendingTask(taskId: string, result: PingResult): void {
    const pending = this.pendingTasks.get(taskId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingTasks.delete(taskId);
    this.recordTaskOutcome(pending.probeId, result, Date.now() - pending.startedAt);
    pending.resolve(result);
  }

  private recordTaskOutcome(probeId: string, result: PingResult, latencyMs: number): void {
    const stats = this.getOrCreateProbeStats(probeId);
    const errorType = classifyProbeError(result.error);
    const isTimeout = errorType === 'timeout';

    if (result.success) {
      this.totalTasksSucceeded += 1;
      stats.tasks_succeeded += 1;
      stats.last_latency_ms = latencyMs;
      stats.recent_latencies_ms.push(latencyMs);
      stats.recent_latencies_ms = stats.recent_latencies_ms.slice(-ProbeManager.RECENT_LATENCY_LIMIT);
      const previousSamples = stats.tasks_succeeded - 1;
      stats.avg_latency_ms = previousSamples === 0
          ? latencyMs
          : Math.round((((stats.avg_latency_ms ?? latencyMs) * previousSamples) + latencyMs) / stats.tasks_succeeded);
      this.refreshDerivedProbeStats(stats);
      return;
    }

    this.totalTasksFailed += 1;
    stats.tasks_failed += 1;
    stats.last_error = result.error;
    stats.last_error_at = new Date().toISOString();
    if (isTimeout) {
      stats.tasks_timed_out += 1;
    }

    if (isTimeout) {
      this.totalTasksTimedOut += 1;
    }

    this.bumpErrorCount(errorType);
    this.refreshDerivedProbeStats(stats);
    this.pushRecentError(probeId, result.error || 'Unknown probe task error');
  }

  private pushRecentError(probeId: string, error: string): void {
    const probe = this.probes.get(probeId);
    this.recentErrors.unshift({
      timestamp: new Date().toISOString(),
      probe_id: probeId,
      region: probe?.region,
      error,
    });
    this.recentErrors = this.recentErrors.slice(0, ProbeManager.RECENT_ERROR_LIMIT);
  }

  private bumpErrorCount(errorType: string): void {
    this.errorCounts.set(errorType, (this.errorCounts.get(errorType) || 0) + 1);
  }

  private refreshDerivedProbeStats(stats: ProbeTaskStats): void {
    stats.success_rate = computeRatio(stats.tasks_succeeded, stats.tasks_sent);
    stats.timeout_ratio = computeRatio(stats.tasks_timed_out, stats.tasks_sent);
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
    const stats = this.getOrCreateProbeStats(id);

    this.probes.set(id, {
      id,
      region,
      socket: normalizedSocket,
      lastPing: Date.now(),
      stats,
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

    const stats = this.getOrCreateProbeStats(id);
    this.totalProbeDisconnects += 1;
    stats.disconnects += 1;
    stats.last_error = `Probe ${id} disconnected`;
    stats.last_error_at = new Date().toISOString();
    this.bumpErrorCount('disconnected');
    this.refreshDerivedProbeStats(stats);
    this.pushRecentError(id, `Probe ${id} disconnected`);
    this.failPendingTasksForProbe(id, `Probe ${id} disconnected`);
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

  getPendingTaskCount(): number {
    return this.pendingTasks.size;
  }

  getObservabilitySummary(): ProbeObservabilitySummary {
    return {
      total_tasks_sent: this.totalTasksSent,
      total_tasks_succeeded: this.totalTasksSucceeded,
      total_tasks_failed: this.totalTasksFailed,
      total_tasks_timed_out: this.totalTasksTimedOut,
      total_probe_disconnects: this.totalProbeDisconnects,
      success_rate: computeRatio(this.totalTasksSucceeded, this.totalTasksSent),
      timeout_ratio: computeRatio(this.totalTasksTimedOut, this.totalTasksSent),
      error_counts: Object.fromEntries(this.errorCounts.entries()),
      recent_errors: this.recentErrors,
    };
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
        stats: {
          ...probe.stats,
          recent_latencies_ms: [...probe.stats.recent_latencies_ms],
        },
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

      const stats = this.getOrCreateProbeStats(probeId);
      this.totalTasksSent += 1;
      stats.tasks_sent += 1;
      this.refreshDerivedProbeStats(stats);
      this.pendingTasks.set(taskId, {
        probeId,
        startedAt: Date.now(),
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

function computeRatio(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Number((part / total).toFixed(4));
}

function classifyProbeError(error: string | undefined): string {
  if (!error) {
    return 'unknown';
  }

  const normalized = error.toLowerCase();
  if (normalized.includes('timeout')) {
    return 'timeout';
  }

  if (normalized.includes('disconnected')) {
    return 'disconnected';
  }

  if (normalized.includes('failed to send task')) {
    return 'send_failed';
  }

  if (normalized.includes('dns resolution failed')) {
    return 'dns_resolution_failed';
  }

  if (normalized.includes('invalid hostname')) {
    return 'invalid_hostname';
  }

  if (normalized.includes('not connected')) {
    return 'probe_not_connected';
  }

  if (normalized.includes('not found')) {
    return 'probe_not_found';
  }

  return 'other';
}

export const probeManager = new ProbeManager();
