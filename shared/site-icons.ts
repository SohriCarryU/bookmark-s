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

/** Explicit overrides must already use HTTPS; never silently rewrite a supplied image URL. */
export function customSiteIconUrl(raw: string): URL | undefined {
  if (raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return undefined
  const value = raw.trim()
  if (!/^https:\/\//i.test(value)) return undefined
  const url = publicIconUrl(value)
  return url && url.href.length <= 4096 ? url : undefined
}

/** Third-party lookups receive only the public hostname, not a bookmark's path or query. */
export function siteIconFallbackUrls(rawOrigin: string): string[] {
  const origin = siteIconOrigin(rawOrigin)
  if (!origin) return []
  const hostname = encodeURIComponent(new URL(origin).hostname)
  return [
    `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
    `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`,
  ]
}

/** A stable cache revision, never an authorization token or a disclosure of a custom URL's query. */
export function siteIconCacheVersion(rawUrl: string, options: { allowFallback: boolean; iconUrl?: string | null }): string | undefined {
  const origin = siteIconOrigin(rawUrl)
  const custom = options.iconUrl ? customSiteIconUrl(options.iconUrl) : undefined
  if (!origin && !custom) return undefined
  let revision = 'auto'
  if (custom) {
    let hash = 0xcbf29ce484222325n
    for (let index = 0; index < custom.href.length; index++) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(custom.href.charCodeAt(index))) * 0x100000001b3n)
    }
    revision = hash.toString(36)
  }
  return `${origin ?? 'custom'}|${options.allowFallback ? 'public' : 'private'}|${revision}`
}
