// Desktop main-process engine delivery and management DTOs.
export interface PlatformTarget {
  os: "darwin" | "windows" | "linux";
  arch: "arm64" | "amd64";
}
export interface EngineInstallation {
  engineId: string;
  pluginId: string;
  pluginVersion: string;
  installationRef: string;
  artifactDigest: string;
  enabled: boolean;
}
export interface EngineUpsert {
  apiVersion: 1;
  revision: number;
  engineId: string;
  pluginId: string;
  pluginVersion: string;
  installationRef: string;
  artifactDigest: string;
  enabled: boolean;
}
export interface EngineSnapshot {
  apiVersion: 1;
  revision: number;
  entries: EngineInstallation[];
}
export interface EngineRevoke {
  apiVersion: 1;
  revision: number;
  engineId: string;
}
export interface ManagementBootstrap {
  schemaVersion: 1;
  hostId: string;
  launchNonce: string;
  managementSecret: string;
  deliveryRoot: string;
}
export interface ManagementStatus {
  apiVersion: 1;
  hostId: string;
  epoch: string;
  ready: boolean;
  appliedRevision: number;
}
export interface SyncAck {
  apiVersion: 1;
  appliedRevision: number;
  action: "applied" | "idempotent";
  ready: boolean;
  drainingEngineIds: string[];
}
export interface DeliverySource {
  kind: "market" | "local-import";
  authorizationRef: string;
  archiveDigest: string;
}
export interface TrustedDeliveryRecord {
  schemaVersion: 1;
  installationRef: string;
  ownerHostId: string;
  pluginId: string;
  pluginVersion: string;
  platform: PlatformTarget;
  artifactDigest: string;
  source: DeliverySource;
}

export interface EngineDirectoryEntry {
  engineId: string;
  pluginId: string;
  pluginVersion: string;
  enabled: boolean;
  syncState: string;
  dependencyState: string;
  authState: string;
  runtimeState: string;
  capabilities: Partial<Record<"question" | "permission" | "configuration" | "resume" | "image" | "file" | "planning" | "access_level" | "service_tier" | "steer" | "boolean_config", boolean>>;
}
export interface EngineDirectory {
  apiVersion: 1;
  catalogGeneration: string;
  revision: number;
  ready: boolean;
  engines: EngineDirectoryEntry[];
}
