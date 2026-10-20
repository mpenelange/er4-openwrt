# Patches

Each directory is a `git format-patch` series; apply it with `git am`.

| Directory | Applies to | Status |
|---|---|---|
| `uek7/` | [oracle/linux-uek](https://github.com/oracle/linux-uek) the tag `UEK7_TAG` in [`versions`](../versions) (UEK7 Update 3, branch `uek7/u3`) | The kernel this port uses. Commit it as branch `er4` in `src/uek7`; see [docs/building.md](../docs/building.md) |
| `ipfwd/` | `cavium-ipfwd-offload/` from Ubiquiti's EdgeOS GPL archive (v3.0.0-rc.9) | History of [`modules/ipfwd`](../modules/ipfwd), which already contains all of it: nothing to apply for a build |

The patches to upstream OpenWrt packages (procd, rpcd, uhttpd) live with the overlay, in
[`openwrt/package/`](../openwrt/package), where OpenWrt's build applies them.
