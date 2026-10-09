export interface BackupResult {
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
