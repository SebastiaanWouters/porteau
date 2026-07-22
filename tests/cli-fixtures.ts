import { rm } from 'node:fs/promises'
import { afterEach, vi } from 'vite-plus/test'
import { defaultConfig, type PorteauConfig } from '../src/core/config.js'
import type { DiagnosticsResult } from '../src/setup/diagnostics.js'
import type { PromptAdapter } from '../src/presentation/prompts.js'

export const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export function config(
  options: {
    user?: string
    password?: string
    databases?: string[]
  } = {},
): PorteauConfig {
  return {
    ...structuredClone(defaultConfig),
    connection: {
      ...structuredClone(defaultConfig.connection),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.password === undefined ? {} : { password: options.password }),
    },
    include: { databases: options.databases ?? [] },
  }
}

export function diagnostics(overrides: Partial<DiagnosticsResult> = {}): DiagnosticsResult {
  const result: DiagnosticsResult = {
    system: {
      status: 'ok',
      platform: 'linux',
      id: 'ubuntu',
      name: 'Ubuntu 24.04',
      version: '24.04',
      codename: 'noble',
      architecture: 'amd64',
      supported: true,
    },
    node: { status: 'ok', version: '24.1.0', minimumVersion: '22.18.0' },
    tools: {
      mydumper: { name: 'mydumper', status: 'ok', version: '1.0.3-1' },
      myloader: { name: 'myloader', status: 'ok', version: '1.0.3-1' },
    },
    toolPair: { status: 'ok' },
    ok: true,
  }
  return { ...result, ...overrides }
}

export const noPrompts: PromptAdapter = {
  text: vi.fn(async () => undefined),
  password: vi.fn(async () => undefined),
  confirm: vi.fn(async () => undefined),
}
