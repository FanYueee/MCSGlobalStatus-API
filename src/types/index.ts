export interface ServerStatus {
  online: boolean;
  host: string;
  port: number;
  ip_info?: IpInfo;
  version?: VersionInfo;
  players?: PlayersInfo;
  motd?: MotdInfo;
  favicon?: string;
  error?: string;
  type?: 'java' | 'bedrock';
}

export interface CombinedStatus {
  java: ServerStatus;
  bedrock: ServerStatus;
}

export interface IpInfo {
  ip?: string;
  ips?: string[];  // All resolved IPs
  srv_record?: SrvRecord;
  asn?: AsnInfo | AsnInfo[];  // Single or multiple ASNs
  location?: LocationInfo;
  dns_records?: DnsRecord[];
}

export interface DnsRecord {
  hostname: string;
  type: 'SRV' | 'A' | 'AAAA' | 'CNAME';
  data: string;
}

export interface DnsSnapshot {
  ip: string | null;
  ips: string[];
  dns_records: DnsRecord[];
}

export interface SrvRecord {
  target: string;
  port: number;
}

export interface AsnInfo {
  number: number;
  org: string;
}

export interface LocationInfo {
  country_code: string;
  country: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

export interface VersionInfo {
  name: string;
  name_clean: string;
  protocol: number;
}

export interface PlayersInfo {
  online: number;
  max: number;
  sample?: PlayerSample[];
}

export interface PlayerSample {
  name: string;
  id: string;
}

export interface MotdInfo {
  raw: string;
  clean: string;
  html: string;
}

export interface ProbeNode {
  id: string;
  region: string;
  socket: WebSocket;
  lastPing: number;
  stats: ProbeTaskStats;
}

export interface ProbeTaskStats {
  tasks_sent: number;
  tasks_succeeded: number;
  tasks_failed: number;
  tasks_timed_out: number;
  recent_latencies_ms: number[];
  last_latency_ms?: number;
  avg_latency_ms?: number;
  success_rate: number;
  timeout_ratio: number;
  last_error?: string;
  last_error_at?: string;
  disconnects: number;
}

export interface ProbeHealthSummary {
  id: string;
  region: string;
  connected: boolean;
  last_seen_at: string;
  last_seen_ago_ms: number;
  pending_tasks: number;
  stats: ProbeTaskStats;
}

export interface RecentProbeError {
  timestamp: string;
  probe_id: string;
  region?: string;
  error: string;
}

export interface ProbeObservabilitySummary {
  total_tasks_sent: number;
  total_tasks_succeeded: number;
  total_tasks_failed: number;
  total_tasks_timed_out: number;
  total_probe_disconnects: number;
  success_rate: number;
  timeout_ratio: number;
  error_counts: Record<string, number>;
  recent_errors: RecentProbeError[];
}

export interface PingTask {
  id: string;
  type: 'ping';
  target: string;
  port: number;
  protocol: 'java' | 'bedrock';
}

export interface PingResult {
  id: string;
  success: boolean;
  data?: ServerStatus;
  error?: string;
}

export interface DistributedResult {
  target: string;
  result_count: number;
  nodes: Record<string, NodeResult>;
}

export interface NodeResult {
  node_region: string;
  status: ServerStatus;
}
