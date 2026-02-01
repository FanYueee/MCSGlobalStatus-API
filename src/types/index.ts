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
  ip: string;
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
