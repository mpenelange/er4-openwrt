# SPDX-License-Identifier: GPL-2.0-only
# ER-4 web UI: the static app from ui/ (build it first: cd ui && npm ci && npm run build),
# served by uhttpd at / instead of LuCI, plus the "er4" rpcd plugin and its ACL.
# The API backends LuCI would bring are dependencies here: rpcd-mod-luci (luci-rpc: leases,
# host hints) and cgi-io (uploads, backup download). Everything else the UI used from luci-base
# and luci-proto-wireguard is in er4.uc. conntrack (conntrack-tools) lists connections over
# netlink. Conflicts with luci-base (both own /www/index.html).
include $(TOPDIR)/rules.mk

PKG_NAME:=er4-ui
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only

ER4_ROOT ?= $(abspath $(TOPDIR)/../..)

include $(INCLUDE_DIR)/package.mk

define Package/er4-ui
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=ER-4 web UI
  DEPENDS:=@TARGET_er4 +rpcd +rpcd-mod-ucode +rpcd-mod-luci +cgi-io +ucode-mod-fs +ucode-mod-uci \
    +uhttpd +uhttpd-mod-ubus +wireguard-tools +conntrack +tcpdump-mini \
    +kmod-tun +ca-bundle +uclient-fetch +jsonfilter
  CONFLICTS:=luci-base
  PKGARCH:=all
endef

define Package/er4-ui/description
  Dense single-page admin UI for the EdgeRouter 4 (Preact app at /) and the rpcd
  plugin "er4" (stats, offload, firmware, ...) it reads live state from. Replaces LuCI.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	[ -f $(ER4_ROOT)/ui/dist/index.html ] || { echo "ui/dist missing: cd ui && npm ci && npm run build"; false; }
	$(CP) $(ER4_ROOT)/ui/dist $(PKG_BUILD_DIR)/www
endef

define Build/Compile
endef

define Package/er4-ui/conffiles
/etc/config/tailscale
endef

define Package/er4-ui/install
	$(INSTALL_DIR) $(1)/www/er4 $(1)/usr/share/rpcd/ucode $(1)/usr/share/rpcd/acl.d $(1)/usr/share/er4 \
		$(1)/usr/libexec $(1)/etc/init.d $(1)/etc/hotplug.d/iface $(1)/etc/uci-defaults $(1)/etc/config $(1)/usr/sbin
	$(CP) $(PKG_BUILD_DIR)/www/. $(1)/www/
	$(INSTALL_DATA) ./files/er4-redirect.html $(1)/www/er4/index.html
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) ./files/luci-redirect.cgi $(1)/www/cgi-bin/luci
	$(INSTALL_DATA) ./files/er4.uc $(1)/usr/share/rpcd/ucode/er4
	$(INSTALL_DATA) ./files/er4.acl.json $(1)/usr/share/rpcd/acl.d/er4.json
	$(INSTALL_DATA) ./files/zoneinfo.json $(1)/usr/share/er4/zoneinfo.json
	$(INSTALL_BIN) ./files/er4-wanmon $(1)/usr/libexec/er4-wanmon
	$(INSTALL_BIN) ./files/er4-wanmon.init $(1)/etc/init.d/er4-wanmon
	$(INSTALL_BIN) ./files/er4-statsmon $(1)/usr/libexec/er4-statsmon
	$(INSTALL_BIN) ./files/er4-statsmon.init $(1)/etc/init.d/er4-statsmon
	$(INSTALL_BIN) ./files/er4-boot.init $(1)/etc/init.d/er4-boot
	$(INSTALL_DATA) ./files/90-er4-wan.hotplug $(1)/etc/hotplug.d/iface/90-er4-wan
	$(INSTALL_BIN) ./files/er4-tailscale.defaults $(1)/etc/uci-defaults/90-er4-tailscale
	# Tailscale: the service and its config; the binaries are fetched onto the eMMC
	# (er4-tailscale-fetch), and /usr/sbin points there
	$(INSTALL_BIN) ./files/tailscale.init $(1)/etc/init.d/tailscale
	$(INSTALL_CONF) ./files/tailscale.config $(1)/etc/config/tailscale
	$(INSTALL_BIN) ./files/er4-tailscale-fetch $(1)/usr/libexec/er4-tailscale-fetch
	$(INSTALL_BIN) ./files/er4-tailscaled-log $(1)/usr/libexec/er4-tailscaled-log
	$(LN) /mnt/er4data/er4/tailscale/tailscale $(1)/usr/sbin/tailscale
	$(LN) /mnt/er4data/er4/tailscale/tailscaled $(1)/usr/sbin/tailscaled
	$(INSTALL_BIN) ./files/er4-ipsec.defaults $(1)/etc/uci-defaults/90-er4-ipsec
	$(INSTALL_BIN) ./files/er4-ssh.defaults $(1)/etc/uci-defaults/90-er4-ssh
endef

$(eval $(call BuildPackage,er4-ui))
