# SPDX-License-Identifier: GPL-2.0-only
include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/image.mk

# No DEVICE_DTS: stock U-Boot passes its own device tree (and the command line, bootoctlinux),
# so the image is the plain stripped ELF.
define Build/strip-kernel
	$(TARGET_CROSS)strip -R .notes $@ -o $@.stripped && mv $@.stripped $@
endef

# The firmware page checks an image by finding the board name in it (er4.uc verify, also on the
# firmware already installed). The initramfs is compressed, so the name isn't readable inside;
# instead it trails the ELF: U-Boot loads by program headers and ignores it.
# The build ID follows it, so the firmware page can tell builds apart (they're all
# "OpenWrt 25.12.5 r33051"): repo commit, kernel commit, build time (unix).
ER4_ROOT := $(abspath $(TOPDIR)/../..)
er4_rev = $(shell git -C $(1) rev-parse --short=7 HEAD 2>/dev/null)$(shell [ -n "$$(git -C $(1) status --porcelain --untracked-files=no 2>/dev/null)" ] && echo -dirty)
define Build/board-tag
	printf '\000er4-board=ubnt,edgerouter-4\000' >> $@
	printf '\000er4-build=%s k%s %s\000' '$(call er4_rev,$(ER4_ROOT))' '$(call er4_rev,$(ER4_ROOT)/src/uek7-openwrt)' "$$(date +%s)" >> $@
endef

define Device/Default
  PROFILES = Default $$(DEVICE_NAME)
  KERNEL_NAME := vmlinux.elf
  KERNEL_INITRAMFS_NAME := vmlinux-initramfs.elf
  KERNEL := kernel-bin | strip-kernel | board-tag
  IMAGES := sysupgrade.tar
  IMAGE/sysupgrade.tar := sysupgrade-tar
endef

define Device/ubnt_edgerouter-4
  DEVICE_VENDOR := Ubiquiti
  DEVICE_MODEL := EdgeRouter 4
  SUPPORTED_DEVICES := ubnt,edgerouter-4
endef
TARGET_DEVICES += ubnt_edgerouter-4

$(eval $(call BuildImage))
