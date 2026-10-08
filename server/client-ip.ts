import { isIP } from 'node:net'

interface Address { bits: number; value: bigint; text: string }
interface Network { bits: number; shift: bigint; prefix: bigint }

function address(input: string | undefined): Address | undefined {
  if (!input || input.includes('%')) return undefined
  const version = isIP(input)
  if (version === 4) {
    const parts = input.split('.').map(Number)
    return { bits: 32, value: parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n), text: parts.join('.') }
  }
  if (version !== 6) return undefined
  let expanded = input.toLowerCase()
  if (expanded.includes('.')) {
    const separator = expanded.lastIndexOf(':')
    const tail = address(expanded.slice(separator + 1))!
    expanded = `${expanded.slice(0, separator)}:${(tail.value >> 16n).toString(16)}:${(tail.value & 65535n).toString(16)}`
  }
  const [left, right] = expanded.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  const groups = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
  const values = groups.map(group => Number.parseInt(group, 16))
  const value = values.reduce((result, group) => (result << 16n) | BigInt(group), 0n)
  // Node commonly reports IPv4 peers as ::ffff:a.b.c.d. Use the same key and
  // allowlist matching as the corresponding plain IPv4 address.
  if (value >> 32n === 65535n) {
    const ipv4 = value & 0xffffffffn
    return { bits: 32, value: ipv4, text: [24n, 16n, 8n, 0n].map(shift => Number((ipv4 >> shift) & 255n)).join('.') }
  }
  let bestStart = -1
  let bestLength = 1
  for (let index = 0; index < values.length;) {
    if (values[index] !== 0) { index++; continue }
    const first = index
    while (index < values.length && values[index] === 0) index++
    if (index - first > bestLength) { bestStart = first; bestLength = index - first }
  }
  const text = values.map(group => group.toString(16))
  return {
    bits: 128, value,
    text: bestStart < 0 ? text.join(':') : `${text.slice(0, bestStart).join(':')}::${text.slice(bestStart + bestLength).join(':')}`,
  }
}

function network(input: string): Network {
  const [host, prefix, extra] = input.split('/')
  const parsed = address(host)
  let length = prefix === undefined ? parsed?.bits : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN
  if (parsed?.bits === 32 && isIP(host) === 6 && prefix !== undefined) length = length !== undefined && length >= 96 ? length - 96 : NaN
  if (!parsed || extra !== undefined || length === undefined || !Number.isInteger(length) || length < 0 || length > parsed.bits) {
    throw new Error(`Invalid TRUSTED_PROXIES entry: ${input || '(empty)'}. Use comma-separated IP addresses or CIDR ranges.`)
  }
  const shift = BigInt(parsed.bits - length)
  return { bits: parsed.bits, shift, prefix: parsed.value >> shift }
}

/** Trust only configured peers, then walk X-Forwarded-For toward the client. */
export function createClientIpResolver(trustedProxies = '') {
  const networks = trustedProxies.trim() ? trustedProxies.split(',').map(value => network(value.trim())) : []
  const trusted = (value: Address) => networks.some(range => range.bits === value.bits && value.value >> range.shift === range.prefix)
  return (socketAddress: string | undefined, forwardedFor: string | undefined): string => {
    const peer = address(socketAddress)
    if (!peer) return 'local'
    if (!trusted(peer) || !forwardedFor || forwardedFor.length > 2048) return peer.text
    const parts = forwardedFor.split(',')
    if (parts.length > 32) return peer.text
    const chain = parts.map(part => address(part.trim()))
    if (chain.some(part => !part)) return peer.text
    let current = peer
    for (let index = chain.length - 1; index >= 0 && trusted(current); index--) current = chain[index]!
    return current.text
  }
}
