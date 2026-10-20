// Template for area mocks: copy to ext/<area>.ts. Shapes must match the real router's replies.
import { registerMock } from '../registry'

registerMock('luci-rpc', {
  // Host names/IPs the router knows per MAC (used to label devices)
  getHostHints: () => ({}),
})
