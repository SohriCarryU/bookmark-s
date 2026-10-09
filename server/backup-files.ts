/** Only exact application backup filenames with a real UTC date are eligible for retention. */
export function backupFileTimestamp(filename: string): number | undefined {
  const match = /^bookmark-s-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}\.sql$/.exec(filename)
  if (!match) return undefined
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`
  const timestamp = Date.parse(iso)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === iso ? timestamp : undefined
}
