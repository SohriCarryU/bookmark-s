import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { publicIconUrl, siteIconOrigin } from '../shared/site-icons.js'

export type SiteIconFetcher = (url: URL, options: { signal: AbortSignal; accept: string }) => Promise<Response>
export interface SiteIcon { bytes: Uint8Array; contentType: string; source: string }
export type SiteIconResolver = (rawUrl: string, options: { allowFallback: boolean }) => Promise<SiteIcon | undefined>

export interface SiteIconResolverOptions {
  totalTimeoutMs?: number
  requestTimeoutMs?: number
  positiveTtlMs?: number
  negativeTtlMs?: number
  maxCacheEntries?: number
  maxCacheBytes?: number
  maxConcurrent?: number
  maxPending?: number
}

const MAX_BYTES = 256 * 1024
const MAX_REDIRECTS = 3
const MAX_CANDIDATES = 4
const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9'
const IMAGE_ACCEPT = 'image/png,image/svg+xml,image/x-icon,image/webp,image/jpeg,image/gif;q=0.9,*/*;q=0.1'
type Element = DefaultTreeAdapterTypes.Element
type Node = DefaultTreeAdapterTypes.Node
type Resource = { bytes: Uint8Array; url: URL; isHtml: boolean }
type ResourceKind = 'html' | 'icon' | 'root'
type CacheEntry = { icon?: SiteIcon; expiresAt: number }

function safeUrl(raw: string, base?: string): URL | undefined {
  const url = publicIconUrl(raw, base)
  return url && siteIconOrigin(url.href) ? url : undefined
}

function bounded(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : maximum
}

function discard(response: Response): void {
  // Cancellation must not extend the request deadline when a remote stream stalls.
  try { void response.body?.cancel().catch(() => {}) } catch { /* Already locked or closed. */ }
}

function isElement(node: Node): node is Element { return 'tagName' in node }
function attribute(node: Element, name: string): string | undefined { return node.attrs.find(attr => attr.name === name)?.value }

function activeHtmlElements(document: DefaultTreeAdapterTypes.Document): Element[] {
  const elements: Element[] = []
  const pending: Node[] = [...document.childNodes].reverse()
  while (pending.length) {
    const node = pending.pop()!
    if (!isElement(node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      || ['script', 'template', 'noscript'].includes(node.tagName)) continue
    elements.push(node)
    pending.push(...[...node.childNodes].reverse())
  }
  return elements
}

function iconPriority(element: Element): number {
  if (element.tagName !== 'link' || !attribute(element, 'href')) return -1
  const rel = attribute(element, 'rel')?.toLowerCase().split(/\s+/) ?? []
  return rel.includes('icon') ? 0 : rel.some(value => value === 'apple-touch-icon' || value === 'apple-touch-icon-precomposed') ? 1 : -1
}

function htmlParts(html: string, locations = false): { head?: Element; body?: Element } {
  const document = parse(html, { scriptingEnabled: true, sourceCodeLocationInfo: locations })
  const root = document.childNodes.find(node => isElement(node) && node.tagName === 'html')
  if (!root || !isElement(root)) return {}
  return {
    head: root.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'head'),
    body: root.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'body'),
  }
}

function headComplete(html: string): boolean {
  if (!/<\/head[\s>]|<body[\s>]/i.test(html)) return false
  const { head, body } = htmlParts(html, true)
  if (!head?.sourceCodeLocation?.endTag && !body?.sourceCodeLocation?.startTag) return false
  // If the head has no icon, retain a bounded body prefix too: some real sites
  // emit inputs before the doctype or place their icon link outside the head.
  return activeHtmlElements(parse(html, { scriptingEnabled: true })).some(element => iconPriority(element) >= 0)
}

async function readBytes(response: Response, html: boolean, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!response.body) return undefined
  if (!html && Number(response.headers.get('content-length')) > MAX_BYTES) { discard(response); return undefined }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const decoder = html ? new TextDecoder() : undefined
  let length = 0
  let text = ''
  let checkedAt = -4096
  let ended = false
  const cancel = () => { try { void reader.cancel().catch(() => {}) } catch { /* Already released. */ } }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) { ended = true; break }
      if (!html && length + value.byteLength > MAX_BYTES) return undefined
      const chunk = value.subarray(0, MAX_BYTES - length)
      if (chunk.byteLength) { chunks.push(chunk); length += chunk.byteLength }
      if (decoder) {
        text += decoder.decode(chunk, { stream: true })
        // Parsing confirms that an apparent closing tag is not inside a script/comment.
        if (length - checkedAt >= 4096) {
          checkedAt = length
          if (headComplete(text)) break
        }
        if (length >= MAX_BYTES) break
      }
    }
    if (signal.aborted || !length) return undefined
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } catch {
    return undefined
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!ended) cancel()
    try { reader.releaseLock() } catch { /* A pending aborted read is being cancelled. */ }
  }
}

function declaredIcons(bytes: Uint8Array, pageUrl: URL): URL[] {
  const elements = activeHtmlElements(parse(new TextDecoder().decode(bytes), { scriptingEnabled: true }))
  const baseElement = elements.find(node => node.tagName === 'base' && attribute(node, 'href') !== undefined)
  const base = baseElement ? safeUrl(attribute(baseElement, 'href')!, pageUrl.href)?.href : pageUrl.href
  const candidates: { url: URL; priority: number }[] = []
  for (const element of elements) {
    const priority = iconPriority(element)
    if (priority < 0) continue
    const href = attribute(element, 'href')
    if (!href) continue
    const url = safeUrl(href, base)
    if (url) candidates.push({ url, priority })
  }
  const unique = new Map<string, URL>()
  for (const { url } of candidates.sort((a, b) => a.priority - b.priority)) {
    if (!unique.has(url.href)) unique.set(url.href, url)
    if (unique.size === MAX_CANDIDATES) break
  }
  return [...unique.values()]
}

function ascii(bytes: Uint8Array, start: number, size: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + size))
}
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
function dimensions(width: number, height: number): boolean { return width > 0 && height > 0 && width <= 4096 && height <= 4096 }

function png(bytes: Uint8Array): boolean {
  if (bytes.length < 45 || ascii(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n') return false
  const data = view(bytes)
  if (data.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR' || !dimensions(data.getUint32(16), data.getUint32(20))) return false
  let offset = 8
  let pixels = false
  while (offset + 12 <= bytes.length) {
    const size = data.getUint32(offset)
    if (size > bytes.length - offset - 12) return false
    const type = ascii(bytes, offset + 4, 4)
    if (type === 'IDAT' && size > 0) pixels = true
    offset += size + 12
    if (type === 'IEND') return size === 0 && pixels && offset === bytes.length
  }
  return false
}

function bitmapIcon(bytes: Uint8Array, width: number, height: number): boolean {
  if (bytes.length < 12) return false
  const data = view(bytes)
  const header = data.getUint32(0, true)
  if (![12, 40, 108, 124].includes(header) || header > bytes.length) return false
  const core = header === 12
  const imageWidth = core ? data.getUint16(4, true) : data.getInt32(4, true)
  const imageHeight = core ? data.getUint16(6, true) : data.getInt32(8, true)
  const planes = data.getUint16(core ? 8 : 12, true)
  const bits = data.getUint16(core ? 10 : 14, true)
  if (imageWidth !== width || Math.abs(imageHeight) !== height * 2 || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits)) return false
  const compression = core ? 0 : data.getUint32(16, true)
  if (![0, 3, 6].includes(compression)) return false
  const colors = core ? (bits <= 8 ? 2 ** bits : 0) : data.getUint32(32, true) || (bits <= 8 ? 2 ** bits : 0)
  const masks = header === 40 ? (compression === 3 ? 12 : compression === 6 ? 16 : 0) : 0
  const pixels = Math.ceil(width * bits / 32) * 4 * height
  const andMask = bits === 32 ? 0 : Math.ceil(width / 32) * 4 * height
  return header + masks + colors * (core ? 3 : 4) + pixels + andMask <= bytes.length
}

function ico(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false
  const data = view(bytes)
  if (data.getUint16(0, true) !== 0 || data.getUint16(2, true) !== 1) return false
  const count = data.getUint16(4, true)
  const directoryEnd = 6 + 16 * count
  if (!count || count > 256 || directoryEnd > bytes.length) return false
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16
    const size = data.getUint32(entry + 8, true)
    const offset = data.getUint32(entry + 12, true)
    if (!size || offset < directoryEnd || offset > bytes.length || size > bytes.length - offset) return false
    const image = bytes.subarray(offset, offset + size)
    const width = bytes[entry] || 256
    const height = bytes[entry + 1] || 256
    if (png(image)) {
      const imageData = view(image)
      if (imageData.getUint32(16) !== width || imageData.getUint32(20) !== height) return false
    } else if (!bitmapIcon(image, width, height)) return false
  }
  return true
}

function safeSvg(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes).trim()
  let content = text
  if (content.startsWith('<?')) {
    const declaration = /^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')(?:\s+encoding\s*=\s*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/.exec(content)
    if (!declaration) return false
    content = content.slice(declaration[0].length).trimStart()
  }
  if (content.includes('<?') || !/^(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>|\/)/.test(content) || /<!DOCTYPE|<!ENTITY/i.test(text)) return false
  const fragment = parseFragment(text, { sourceCodeLocationInfo: true })
  const elements = fragment.childNodes.filter(isElement)
  if (elements.length !== 1 || fragment.childNodes.some(node => node.nodeName === '#text' && 'value' in node && node.value.trim())) return false
  const root = elements[0]
  if (root.tagName !== 'svg' || attribute(root, 'xmlns') !== 'http://www.w3.org/2000/svg') return false
  const location = root.sourceCodeLocation
  if (!location?.endTag && !(location?.startTag && text.slice(location.startTag.startOffset, location.startTag.endOffset).endsWith('/>'))) return false
  const safeCss = (css: string) => !/\\|@import|expression\s*\(/i.test(css) && [...css.matchAll(/url\s*\(([^)]*)\)/gi)].every(match => /^['"]?#[^\s'"]+['"]?$/.test(match[1].trim()))
  const pending: Node[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (!isElement(node)) continue
    if (node.namespaceURI !== 'http://www.w3.org/2000/svg' || node.tagName.includes(':')
      || ['script', 'foreignobject', 'iframe', 'object', 'embed', 'a', 'animate', 'animatecolor', 'animatemotion', 'animatetransform', 'set', 'discard', 'mpath'].includes(node.tagName.toLowerCase())) return false
    for (const attr of node.attrs) {
      if (/^on/i.test(attr.name) || (attr.name === 'href' && attr.value && !attr.value.startsWith('#'))) return false
      if ((attr.name === 'style' || /url\s*\(/i.test(attr.value)) && !safeCss(attr.value)) return false
    }
    if (node.tagName === 'style' && !safeCss(node.childNodes.map(child => 'value' in child ? child.value : '').join(''))) return false
    pending.push(...node.childNodes)
  }
  return true
}

function imageType(bytes: Uint8Array): string | undefined {
  if (png(bytes)) return 'image/png'
  if (ico(bytes)) return 'image/x-icon'
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)) && bytes.at(-1) === 0x3b) {
    const data = view(bytes)
    if (dimensions(data.getUint16(6, true), data.getUint16(8, true))) return 'image/gif'
  }
  if (bytes.length >= 24 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const data = view(bytes)
    if (data.getUint32(4, true) + 8 === bytes.length) {
      let offset = 12
      let pixels = false
      while (offset + 8 <= bytes.length) {
        const size = data.getUint32(offset + 4, true)
        if (size > bytes.length - offset - 8) return undefined
        if (['VP8 ', 'VP8L', 'ANMF'].includes(ascii(bytes, offset, 4)) && size > 0) pixels = true
        offset += 8 + size + size % 2
      }
      if (pixels && offset === bytes.length) return 'image/webp'
    }
  }
  if (bytes.length >= 24 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg'
  if (safeSvg(bytes)) return 'image/svg+xml'
  return undefined
}

/** Resolves only icons for an origin; callers must authorize the saved bookmark first. */
export function createSiteIconResolver(fetcher: SiteIconFetcher, options: SiteIconResolverOptions = {}): SiteIconResolver {
  const totalTimeout = bounded(options.totalTimeoutMs, 12_000)
  const requestTimeout = bounded(options.requestTimeoutMs, 3_500)
  const homepageTimeout = options.requestTimeoutMs === undefined ? 5_000 : requestTimeout
  const positiveTtl = bounded(options.positiveTtlMs, 6 * 60 * 60 * 1000)
  const negativeTtl = bounded(options.negativeTtlMs, 5 * 60 * 1000)
  const maxEntries = bounded(options.maxCacheEntries, 128)
  const maxCacheBytes = bounded(options.maxCacheBytes, 16 * 1024 * 1024)
  const maxConcurrent = bounded(options.maxConcurrent, 8)
  const maxPending = bounded(options.maxPending, 64)
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<SiteIcon | undefined>>()
  const queue: { start: () => void; timer?: ReturnType<typeof setTimeout> }[] = []
  let active = 0
  let cacheBytes = 0

  async function resource(initial: URL, kind: ResourceKind, timeout: number): Promise<Resource | undefined> {
    if (timeout < 1) return undefined
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const expired = new Promise<undefined>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(undefined) }, timeout)
    })
    const work = async (): Promise<Resource | undefined> => {
      let url = safeUrl(initial.href)
      const seen = new Set<string>()
      for (let redirects = 0; url && redirects <= MAX_REDIRECTS && !controller.signal.aborted; redirects++) {
        if (seen.has(url.href)) return undefined
        seen.add(url.href)
        const response = await fetcher(url, { signal: controller.signal, accept: kind === 'html' ? HTML_ACCEPT : IMAGE_ACCEPT })
        if (controller.signal.aborted || response.redirected) { discard(response); return undefined }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          discard(response)
          if (redirects === MAX_REDIRECTS || !location) return undefined
          url = safeUrl(location, url.href)
          continue
        }
        if (response.status < 200 || response.status >= 300) { discard(response); return undefined }
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        const declaredHtml = Boolean(type && ['text/html', 'application/xhtml+xml'].includes(type))
        if (kind === 'html' && type && !declaredHtml) { discard(response); return undefined }
        const bytes = await readBytes(response, kind === 'html' || (kind === 'root' && declaredHtml), controller.signal)
        if (!bytes) return undefined
        const isHtml = declaredHtml || /^\s*(?:<!doctype\s+html\b|<(?:html|head|meta|link|input)\b)/i.test(new TextDecoder().decode(bytes.subarray(0, 1024)))
        return { bytes, url, isHtml }
      }
      return undefined
    }
    try { return await Promise.race([work().catch(() => undefined), expired]) }
    finally { clearTimeout(timer!); controller.abort() }
  }

  async function discover(origin: string, allowFallback: boolean, deadline: number): Promise<SiteIcon | undefined> {
    const remaining = () => Math.max(0, deadline - performance.now())
    const homepage = safeUrl(origin)!
    const page = await resource(homepage, 'html', Math.min(homepageTimeout, remaining()))
    const candidates = page ? declaredIcons(page.bytes, page.url) : []
    const rootIcon = safeUrl('/favicon.ico', origin)!
    const fallback = allowFallback ? safeUrl(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(homepage.hostname)}.ico`) : undefined
    const attempted = new Map<string, Resource | undefined>()
    async function retrieve(url: URL, remainingRequests: number): Promise<Resource | undefined> {
      if (attempted.has(url.href)) return attempted.get(url.href)
      // Reserve a share of the remaining budget for every subsequent fallback.
      const budget = Math.min(requestTimeout, remaining() / remainingRequests)
      const result = await resource(url, url.href === rootIcon.href ? 'root' : 'icon', budget)
      attempted.set(url.href, result)
      return result
    }
    function asIcon(result: Resource | undefined): SiteIcon | undefined {
      if (!result) return undefined
      const contentType = imageType(result.bytes)
      if (contentType) return { bytes: result.bytes, contentType, source: result.url.href }
    }
    for (let index = 0; index < candidates.length; index++) {
      const icon = asIcon(await retrieve(candidates[index], candidates.length - index + 1 + (fallback ? 1 : 0)))
      if (icon) return icon
    }
    const root = await retrieve(rootIcon, 1 + (fallback ? 1 : 0))
    const rootImage = asIcon(root)
    if (rootImage) return rootImage
    // Some SPAs serve their app HTML at /favicon.ico. Inspect this one document,
    // sharing the same four-candidate and total-time budgets; never recurse.
    if (root?.isHtml && candidates.length < MAX_CANDIDATES) {
      const extra = declaredIcons(root.bytes, root.url).filter(url => !attempted.has(url.href)).slice(0, MAX_CANDIDATES - candidates.length)
      for (let index = 0; index < extra.length; index++) {
        const icon = asIcon(await retrieve(extra[index], extra.length - index + (fallback ? 1 : 0)))
        if (icon) return icon
      }
    }
    return fallback ? asIcon(await retrieve(fallback, 1)) : undefined
  }

  function remove(key: string): void {
    const entry = cache.get(key)
    if (entry) cacheBytes -= entry.icon?.bytes.byteLength ?? 0
    cache.delete(key)
  }

  function remember(key: string, icon: SiteIcon | undefined): void {
    const now = Date.now()
    for (const [storedKey, entry] of cache) if (entry.expiresAt <= now) remove(storedKey)
    remove(key)
    const size = icon?.bytes.byteLength ?? 0
    if (size > maxCacheBytes) return
    while (cache.size >= maxEntries || cacheBytes + size > maxCacheBytes) remove(cache.keys().next().value!)
    cache.set(key, { icon, expiresAt: now + (icon ? positiveTtl : negativeTtl) })
    cacheBytes += size
  }

  const copy = (icon: SiteIcon | undefined): SiteIcon | undefined => icon && { ...icon, bytes: icon.bytes.slice() }
  function drain(): void {
    while (active < maxConcurrent && queue.length) {
      const next = queue.shift()!
      clearTimeout(next.timer)
      next.start()
    }
  }

  return (rawUrl, { allowFallback }) => {
    const origin = siteIconOrigin(rawUrl)
    if (!origin || !safeUrl(origin)) return Promise.resolve(undefined)
    const key = `${origin}|${allowFallback === true ? 1 : 0}`
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(key)
      cache.set(key, cached)
      return Promise.resolve(copy(cached.icon))
    }
    if (cached) remove(key)
    const pending = inFlight.get(key)
    if (pending) return pending.then(copy)
    if (active >= maxConcurrent && queue.length >= maxPending) return Promise.resolve(undefined)
    const deadline = performance.now() + totalTimeout
    const request = new Promise<SiteIcon | undefined>(resolve => {
      const start = () => {
        if (deadline - performance.now() < 1) { resolve(undefined); return }
        active++
        void discover(origin, allowFallback === true, deadline).catch(() => undefined)
          .then(icon => { remember(key, icon); return icon })
          .finally(() => { active--; drain() }).then(resolve)
      }
      if (active < maxConcurrent) start()
      else {
        const waiting: { start: () => void; timer?: ReturnType<typeof setTimeout> } = { start }
        waiting.timer = setTimeout(() => {
          const index = queue.indexOf(waiting)
          if (index >= 0) queue.splice(index, 1)
          // Queue pressure is transient, so do not turn it into a cached miss.
          resolve(undefined)
        }, Math.max(1, deadline - performance.now()))
        queue.push(waiting)
      }
    }).finally(() => { inFlight.delete(key) })
    inFlight.set(key, request)
    return request.then(copy)
  }
}
