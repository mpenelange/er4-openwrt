// WireGuard keys in the browser (WebCrypto X25519), so a new peer's private key never leaves
// the browser. WebCrypto needs a secure context (https or localhost); on plain http the
// caller falls back to the router (er4 wg_keypair). No imports from the
// client here: the mock uses this file too.

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const fromUrl = (s: string) => b64(unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)))

// PKCS#8 header for a raw 32-byte X25519 private key (RFC 8410)
const PKCS8_X25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]

export const canGenerateLocally = () => typeof crypto !== 'undefined' && !!crypto.subtle

export async function generateKeyPairLocal(): Promise<{ priv: string; pub: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  if (!jwk.d || !jwk.x) throw new Error('X25519 export unsupported')
  return { priv: fromUrl(jwk.d), pub: fromUrl(jwk.x) }
}

/** Public key for a base64 private key, or undefined if this browser can't compute it. */
export async function publicFromPrivate(priv: string): Promise<string | undefined> {
  try {
    const raw = unb64(priv)
    if (raw.length !== 32) return undefined
    const der = new Uint8Array([...PKCS8_X25519, ...raw])
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'X25519' }, true, ['deriveBits'])
    const jwk = await crypto.subtle.exportKey('jwk', key)
    return jwk.x ? fromUrl(jwk.x) : undefined
  } catch {
    return undefined
  }
}

/** Preshared key: 32 random bytes (what `wg genpsk` does). getRandomValues works on plain http too. */
export function randomKey(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)))
}

export const isWgKey = (s: string) => /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(s.trim())
