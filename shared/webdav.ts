export interface WebDavSettingsInput {
  endpointUrl: string
  username: string
  /** Omit or leave empty to keep the saved password for the same endpoint and account. */
  password?: string
  remoteDirectory: string
  autoBackupEnabled: boolean
  /** HH:mm in Asia/Shanghai. */
  backupTime: string
  /** Zero keeps every backup. Omission preserves the existing policy for older clients. */
  retentionCount?: number
}

export interface WebDavBackupResult {
  status: 'running' | 'success' | 'error'
  trigger: 'manual' | 'scheduled'
  startedAt: string
  finishedAt: string | null
  fileName: string | null
  sizeBytes: number | null
  error: string | null
  /** Upload succeeded, but old backups could not all be pruned. */
  cleanupWarning?: string | null
  deletedBackupCount?: number
}

export interface WebDavSettings {
  configured: boolean
  endpointUrl: string
  username: string
  hasPassword: boolean
  remoteDirectory: string
  autoBackupEnabled: boolean
  backupTime: string
  retentionCount: number
  timeZone: 'Asia/Shanghai'
  nextBackupAt: string | null
  lastSuccessAt: string | null
  lastBackup: WebDavBackupResult | null
}
