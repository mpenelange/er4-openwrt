// Shared by the VPN views.
import { useEffect, useState } from 'preact/hooks'
import { str } from '../../api/firewall'
import { publicFromPrivate } from '../../api/wgkeys'
import type { WgInstance } from '../../api/wireguard'
import type { UciConfig, UciSection } from '../../api/types'

export interface VpnData {
  net: UciConfig
  fw: UciConfig
  /** network sections with unapplied changes */
  staged: Set<string>
  wanAddr?: string
}

/** Router's public key: from the running interface, else derived from the staged private key. */
export function useServerPub(iface: UciSection, inst?: WgInstance) {
  const [derived, setDerived] = useState<string | undefined>()
  const priv = str(iface.private_key)
  useEffect(() => {
    if (inst?.public_key || !priv) return
    publicFromPrivate(priv).then(setDerived)
  }, [priv, inst?.public_key])
  return inst?.public_key || derived
}
