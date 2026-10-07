// Workers Web Crypto supports PBKDF2 with at most 100,000 iterations.
const ITERATIONS = 100_000
const encoder = new TextEncoder()
const toHex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
const fromHex = (value: string) => Uint8Array.from(value.match(/../g)!, pair => Number.parseInt(pair, 16))

async function derive(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new Uint8Array(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256))
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${ITERATIONS}$${toHex(salt)}$${toHex(await derive(password, salt))}`
}

export async function verifyPassword(password: string, stored: string | undefined) {
  const parts = stored?.split('$')
  const valid = parts?.length === 4 && parts[0] === 'pbkdf2-sha256' && parts[1] === String(ITERATIONS)
    && /^[0-9a-f]{32}$/.test(parts[2]) && /^[0-9a-f]{64}$/.test(parts[3])
  // Unknown users still perform the same password derivation as known accounts.
  const supplied = await derive(password, valid ? fromHex(parts[2]) : new Uint8Array(16))
  const expected = valid ? fromHex(parts[3]) : new Uint8Array(32)
  let difference = 0
  for (let index = 0; index < supplied.length; index++) difference |= supplied[index] ^ expected[index]
  return Boolean(valid) && difference === 0
}
