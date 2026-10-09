import type { BackupResult } from './backup.js'

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

export type WebDavBackupResult = BackupResult

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
