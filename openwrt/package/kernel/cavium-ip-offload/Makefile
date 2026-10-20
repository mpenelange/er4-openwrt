# SPDX-License-Identifier: GPL-2.0-only
# UBNT/Cavium flow offload for the Octeon SDK ethernet driver, from modules/ipfwd (our port).
include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

PKG_NAME:=cavium-ip-offload
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only

# Sources: modules/ipfwd in this repo (setup.sh links the package into src/openwrt)
ER4_ROOT ?= $(abspath $(TOPDIR)/../..)

include $(INCLUDE_DIR)/package.mk

define KernelPackage/cavium-ip-offload
  SUBMENU:=Network Support
  TITLE:=Cavium Octeon IP flow offload (UBNT ipfwd)
  DEPENDS:=@TARGET_er4
  FILES:=$(PKG_BUILD_DIR)/cavium-ip-offload.ko
endef

define KernelPackage/cavium-ip-offload/description
  Forwards established IPv4/IPv6 flows in the Octeon ethernet driver's receive path,
  bypassing the kernel stack. Loaded by /etc/init.d/offload (config: /etc/config/offload).
endef

define KernelPackage/cavium-ip-offload/conffiles
/etc/config/offload
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	cd $(ER4_ROOT)/modules/ipfwd && git ls-files -z | \
		xargs -0 -I{} cp --parents {} $(PKG_BUILD_DIR)/
endef

define Build/Compile
	+$(KERNEL_MAKE) M=$(PKG_BUILD_DIR) KERNEL_SRC_DIR=$(LINUX_DIR) MODULE_TOPDIR=$(PKG_BUILD_DIR) modules
endef

define KernelPackage/cavium-ip-offload/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d
	$(INSTALL_CONF) ./files/offload.config $(1)/etc/config/offload
	$(INSTALL_BIN) ./files/offload.init $(1)/etc/init.d/offload
endef

$(eval $(call KernelPackage,cavium-ip-offload))
