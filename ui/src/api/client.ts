// The one Ubus instance. Real router when built for the router or when VITE_UBUS is set
// (dev proxy), the mock backend otherwise (npm run dev with no router), or with ?mock in the URL.
import { Ubus, httpTransport } from './ubus'
import { mockTransport } from './mock'

const useMock = new URLSearchParams(location.search).has('mock') || (import.meta.env.DEV && !import.meta.env.VITE_UBUS)

export const api = new Ubus(useMock ? mockTransport : httpTransport('/ubus'))
export const isMock = useMock
