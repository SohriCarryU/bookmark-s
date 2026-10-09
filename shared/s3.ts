import type { BackupResult } from './backup.js'

export type S3BackupResult = BackupResult

export interface S3SettingsInput {
  endpointUrl: string
  region: string
  bucket: string
  accessKeyId: string
  /** Omit or leave empty to keep the saved secret for the same endpoint and access key. */
  secretAccessKey?: string
  /** Relative object prefix; normalized to a trailing slash, or empty for the bucket root. */
  prefix: string
  forcePathStyle: boolean
  autoBackupEnabled: boolean
  /** HH:mm in Asia/Shanghai. */
  backupTime: string
  /** Zero keeps every backup. */
  retentionCount: number
}

export interface S3Settings {
  configured: boolean
  endpointUrl: string
  region: string
  bucket: string
  accessKeyId: string
  hasSecretAccessKey: boolean
  prefix: string
  forcePathStyle: boolean
  autoBackupEnabled: boolean
  backupTime: string
  retentionCount: number
  timeZone: 'Asia/Shanghai'
  nextBackupAt: string | null
  lastSuccessAt: string | null
  lastBackup: S3BackupResult | null
}
