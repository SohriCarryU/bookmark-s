const localSuffixes = ['localhost', 'local', 'lan', 'internal', 'home', 'home.arpa', 'test', 'example', 'invalid', 'onion']

/** Syntactic policy shared by the UI and resolver; Node additionally checks and pins DNS. */
export function publicIconUrl(raw: string, base?: string): URL | undefined {
  try {
    const value = raw.trim()
    if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return undefined
    const url = new URL(value, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (hostname.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
      || localSuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return undefined
    url.protocol = 'https:'
    if (url.port) return undefined
    url.hostname = hostname
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

/** Only a site's origin is used for discovery, never a bookmarked private path or query. */
export function siteIconOrigin(raw: string): string | undefined {
  return publicIconUrl(raw)?.origin
}
