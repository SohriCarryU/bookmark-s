import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientIpResolver } from './client-ip.js'

test('mapped IPv6 CIDRs retain IPv6 prefix semantics when normalized to IPv4', () => {
  const resolve = createClientIpResolver('::ffff:192.0.2.128/121')
  assert.equal(resolve('192.0.2.128', '198.51.100.1'), '198.51.100.1')
  assert.equal(resolve('::ffff:192.0.2.255', '198.51.100.1'), '198.51.100.1')
  assert.equal(resolve('192.0.2.127', '198.51.100.1'), '192.0.2.127')
  for (const prefix of [0, 24, 32, 95, 129]) assert.throws(() => createClientIpResolver(`::ffff:192.0.2.128/${prefix}`), /TRUSTED_PROXIES/)
})

test('forwarded addresses are ignored unless a trusted proxy is explicitly configured', () => {
  for (const trustedProxies of [undefined, '']) {
    const resolve = createClientIpResolver(trustedProxies)
    assert.equal(resolve('198.51.100.23', '203.0.113.42'), '198.51.100.23')
    assert.equal(resolve('127.0.0.1', '203.0.113.42, 127.0.0.1'), '127.0.0.1')
    assert.equal(resolve('::ffff:198.51.100.23', '203.0.113.42'), '198.51.100.23')
  }
})

test('only the actual socket peer can establish trust in a forwarded header', () => {
  const resolve = createClientIpResolver('10.0.0.0/8')
  assert.equal(resolve('198.51.100.23', '203.0.113.42, 10.0.0.1'), '198.51.100.23')
  assert.equal(resolve('192.168.1.1', '10.0.0.1'), '192.168.1.1')
  assert.equal(resolve('10.0.0.1', '198.51.100.23'), '198.51.100.23')
})

test('an exact trusted proxy accepts one forwarded client and preserves the peer when the header is absent', () => {
  const resolve = createClientIpResolver('192.0.2.10')
  assert.equal(resolve('192.0.2.10', '198.51.100.23'), '198.51.100.23')
  assert.equal(resolve('192.0.2.11', '198.51.100.23'), '192.0.2.11')
  assert.equal(resolve('192.0.2.10', undefined), '192.0.2.10')
})

test('multiple trusted proxies are traversed from the socket toward the original client', () => {
  const resolve = createClientIpResolver('10.0.0.0/8, 192.0.2.10, 2001:db8:ffff::/48')
  assert.equal(resolve('10.0.0.1', ' 198.51.100.23 , 192.0.2.10, 2001:db8:ffff::2 '), '198.51.100.23')
  assert.equal(resolve('10.0.0.1', '10.0.0.2, 192.0.2.10'), '10.0.0.2')
})

test('an untrusted intermediate hop prevents client-controlled addresses farther left from being used', () => {
  const resolve = createClientIpResolver('10.0.0.0/8')
  assert.equal(resolve('10.0.0.1', '203.0.113.42, 198.51.100.23, 10.0.0.2'), '198.51.100.23')
  assert.equal(resolve('10.0.0.1', '203.0.113.42, 10.0.0.2, 198.51.100.23'), '198.51.100.23')
})

test('IPv4 CIDRs include both boundary addresses without trusting adjacent networks', () => {
  const resolve = createClientIpResolver('192.0.2.128/25')
  for (const peer of ['192.0.2.128', '192.0.2.255']) {
    assert.equal(resolve(peer, '198.51.100.23'), '198.51.100.23', peer)
  }
  for (const peer of ['192.0.2.127', '192.0.3.0']) {
    assert.equal(resolve(peer, '198.51.100.23'), peer, peer)
  }
})

test('IPv6 CIDRs respect prefix boundaries within a hextet', () => {
  const resolve = createClientIpResolver('2001:db8::/33')
  for (const peer of ['2001:db8::', '2001:db8:7fff:ffff:ffff:ffff:ffff:ffff']) {
    assert.equal(resolve(peer, '198.51.100.23'), '198.51.100.23', peer)
  }
  for (const peer of ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db8:8000::']) {
    assert.equal(resolve(peer, '198.51.100.23'), peer, peer)
  }
})

test('host-length CIDRs trust only the configured IPv4 or IPv6 address', () => {
  for (const [cidr, trusted, untrusted] of [
    ['192.0.2.10/32', '192.0.2.10', '192.0.2.11'],
    ['2001:db8::1/128', '2001:db8::1', '2001:db8::2'],
  ]) {
    const resolve = createClientIpResolver(cidr)
    assert.equal(resolve(trusted, '198.51.100.23'), '198.51.100.23', cidr)
    assert.equal(resolve(untrusted, '198.51.100.23'), untrusted, cidr)
  }
})

test('zero-length prefixes trust all addresses of their own family', () => {
  const ipv4 = createClientIpResolver('0.0.0.0/0')
  assert.equal(ipv4('203.0.113.42', '198.51.100.23'), '198.51.100.23')
  assert.equal(ipv4('2001:db8::1', '198.51.100.23'), '2001:db8::1')
  const ipv6 = createClientIpResolver('::/0')
  assert.equal(ipv6('2001:db8::1', '198.51.100.23'), '198.51.100.23')
  assert.equal(ipv6('203.0.113.42', '198.51.100.23'), '203.0.113.42')
})

test('IPv4-mapped IPv6 peers and intermediate hops match IPv4 proxy ranges', () => {
  const resolve = createClientIpResolver('10.0.0.0/8')
  assert.equal(resolve('::ffff:10.0.0.1', '::ffff:198.51.100.23, ::ffff:10.0.0.2'), '198.51.100.23')
  assert.equal(resolve('::FFFF:0A00:0001', '::FFFF:C633:6417'), '198.51.100.23')
  assert.equal(resolve('::ffff:198.51.100.23', '203.0.113.42'), '198.51.100.23')
})

test('IPv6 addresses are returned in lowercase with canonical zero compression', () => {
  const resolve = createClientIpResolver()
  for (const [address, expected] of [
    ['2001:0DB8:0000:0000:0000:0000:0000:ABCD', '2001:db8::abcd'],
    ['2001:0DB8:0000:0000:0001:0000:0000:0001', '2001:db8::1:0:0:1'],
    ['2001:0DB8:0000:0001:0002:0003:0004:0005', '2001:db8:0:1:2:3:4:5'],
    ['0000:0000:0000:0000:0000:0000:0000:0000', '::'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', '::1'],
  ]) {
    assert.equal(resolve(address, undefined), expected, address)
  }
  const proxy = createClientIpResolver('2001:0DB8:FFFF:0000:0000:0000:0000:0001')
  assert.equal(proxy('2001:db8:ffff::1', '2001:0DB8:ABCD:0000:0000:0000:0000:0005'), '2001:db8:abcd::5')
})

test('missing or invalid socket addresses fall back to local even with trusted proxy ranges', () => {
  const resolve = createClientIpResolver('0.0.0.0/0, ::/0')
  for (const peer of [undefined, '', 'unknown', 'not-an-ip', '198.51.100.23:443', '[2001:db8::1]']) {
    assert.equal(resolve(peer, '198.51.100.23'), 'local', String(peer))
    assert.equal(resolve(peer, undefined), 'local', String(peer))
  }
})

test('empty or malformed forwarded headers fall back to the normalized socket address', () => {
  const resolve = createClientIpResolver('10.0.0.0/8')
  for (const header of [
    '',
    ' ',
    ',',
    ', 198.51.100.23',
    '198.51.100.23,',
    '198.51.100.23, , 10.0.0.2',
    'unknown',
    '198.51.100.23:443',
    '[2001:db8::1]',
    '[2001:db8::1]:443',
    '"198.51.100.23"',
    'for=198.51.100.23',
    'fe80::1%eth0',
    'fe80::1%1',
    '198.51.100.23/32',
    '010.0.0.1',
    '0x7f000001',
    '2130706433',
    '999.0.0.1',
    '2001:db8::gg',
    '198.51.\n100.23',
  ]) {
    assert.equal(resolve('::ffff:10.0.0.1', header), '10.0.0.1', JSON.stringify(header))
  }
})

test('an invalid address anywhere invalidates the entire forwarded chain', () => {
  const resolve = createClientIpResolver('10.0.0.0/8')
  for (const header of [
    'unknown, 198.51.100.23',
    '198.51.100.23, unknown, 10.0.0.2',
    '198.51.100.23, 10.0.0.2, unknown',
    '198.51.100.23,, 198.51.100.24',
    'fe80::1%eth0, 198.51.100.23',
    '"203.0.113.42", 198.51.100.23',
  ]) {
    assert.equal(resolve('10.0.0.1', header), '10.0.0.1', header)
  }
})

test('forwarded headers accept at most 2048 characters before whitespace is trimmed', () => {
  const resolve = createClientIpResolver('10.0.0.0/8')
  const header = '198.51.100.23'.padEnd(2048, ' ')
  assert.equal(resolve('10.0.0.1', header), '198.51.100.23')
  assert.equal(resolve('10.0.0.1', `${header} `), '10.0.0.1')
})

test('forwarded headers accept 32 hops and fall back to the peer at 33 hops', () => {
  const resolve = createClientIpResolver('10.0.0.0/8')
  const hops = ['198.51.100.23', ...Array<string>(31).fill('10.0.0.2')]
  assert.equal(resolve('10.0.0.1', hops.join(', ')), '198.51.100.23')
  assert.equal(resolve('10.0.0.1', [...hops, '10.0.0.2'].join(', ')), '10.0.0.1')
})

test('invalid proxy addresses, empty entries and invalid CIDRs fail during configuration', () => {
  for (const trustedProxies of [
    'localhost',
    '*',
    'unknown',
    '999.0.0.1',
    '010.0.0.1',
    '127.0.0.1:3000',
    '[::1]',
    'fe80::1%eth0',
    '10.0.0.1,,10.0.0.2',
    '10.0.0.1, ,10.0.0.2',
    ',10.0.0.1',
    '10.0.0.1,',
    '10.0.0.1,invalid',
    '/24',
    '10.0.0.0/',
    '10.0.0.0/-1',
    '10.0.0.0/33',
    '10.0.0.0/1.5',
    '10.0.0.0/8suffix',
    '10.0.0.0/8/16',
    '2001:db8::/-1',
    '2001:db8::/129',
    '2001:db8::/64.5',
    '2001:db8::/prefix',
    '2001:db8::/64/64',
  ]) {
    assert.throws(() => createClientIpResolver(trustedProxies), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /TRUSTED_PROXIES/)
      return true
    }, trustedProxies)
  }
})
