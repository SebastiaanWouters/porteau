import type { EngineEvent } from './events.js'

export type EngineTool = 'mydumper' | 'myloader'
export type ExecutionProfile = 'production' | 'replica' | 'expert'

export interface EngineContext {
  readonly mydumperPath: string
  readonly myloaderPath: string
}

export interface EngineCapabilities {
  readonly engineVersion: string
  readonly machineLog: {
    readonly schemaVersion: string
    readonly eventVersion: string
  }
  readonly tools: Readonly<Record<EngineTool, { path: string; version: string }>>
}

export interface BackupRequest {
  readonly outputDirectory: string
  readonly profile: ExecutionProfile
}

export interface RestoreRequest {
  readonly artifactPath: string
  readonly destinationDatabase: string
}

export interface ArtifactVerification {
  readonly valid: boolean
  readonly errors: readonly string[]
}

export interface BackupEngine {
  inspect(context: EngineContext): Promise<EngineCapabilities>
  backup(request: BackupRequest): AsyncIterable<EngineEvent>
  restore(request: RestoreRequest): AsyncIterable<EngineEvent>
  verifyArtifact(path: string): Promise<ArtifactVerification>
}
