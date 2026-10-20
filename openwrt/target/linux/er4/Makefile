# SPDX-License-Identifier: GPL-2.0-only
# EdgeRouter 4 on Oracle UEK7 U3 (5.15) with the Cavium flow offload.
# The kernel is not downloaded or patched: CONFIG_EXTERNAL_KERNEL_TREE points at a git worktree
# of src/uek7 (branch er4), see ../../../README.md. config-5.15 is a complete kernel config.

include $(TOPDIR)/rules.mk

ARCH:=mips64
BOARD:=er4
BOARDNAME:=EdgeRouter 4 (UEK7, flow offload)
FEATURES:=ext4 squashfs ramdisk usb
CPU_TYPE:=octeonplus

SUBTARGETS:=generic

KERNEL_PATCHVER:=5.15

define Target/Description
	EdgeRouter 4 (Octeon III CN7130) with the Oracle UEK7 kernel and Cavium flow offload.
endef

include $(INCLUDE_DIR)/target.mk

DEFAULT_PACKAGES += e2fsprogs kmod-cavium-ip-offload

# The kernel config is ours (configs/er4.fragment, tested on hardware): unlike
# Kernel/Configure/Default, don't copy OpenWrt's CONFIG_KERNEL_* defaults over it (they turn
# off stack-protector-strong, LSM and devtmpfs and turn on MPTCP, cgroup extras, -Werror...).
# Selected kmods still add their symbols as =m; olddefconfig fills in their dependencies.
define Kernel/Configure
	rm -f $(LINUX_DIR)/localversion
	$(LINUX_CONF_CMD) > $(LINUX_DIR)/.config.target
	echo "# CONFIG_KALLSYMS_EXTRA_PASS is not set" >> $(LINUX_DIR)/.config.target
	$(SCRIPT_DIR)/package-metadata.pl kconfig $(TMP_DIR)/.packageinfo $(TOPDIR)/.config $(KERNEL_PATCHVER) > $(LINUX_DIR)/.config.override
	$(SCRIPT_DIR)/kconfig.pl 'm+' '+' $(LINUX_DIR)/.config.target /dev/null $(LINUX_DIR)/.config.override > $(LINUX_DIR)/.config.set
	$(call Kernel/SetNoInitramfs)
	rm -rf $(KERNEL_BUILD_DIR)/modules
	cmp -s $(LINUX_DIR)/.config.set $(LINUX_DIR)/.config.prev || { \
		cp $(LINUX_DIR)/.config.set $(LINUX_DIR)/.config; \
		cp $(LINUX_DIR)/.config.set $(LINUX_DIR)/.config.prev; \
	}
	+$(KERNEL_MAKE) olddefconfig
	$(_SINGLE) [ -d $(LINUX_DIR)/user_headers ] || $(KERNEL_MAKE) $(if $(findstring uml,$(BOARD)),ARCH=$(ARCH)) INSTALL_HDR_PATH=$(LINUX_DIR)/user_headers headers_install
	grep '=[ym]' $(LINUX_DIR)/.config.set | LC_ALL=C sort | $(MKHASH) md5 > $(LINUX_DIR)/.vermagic
endef

$(eval $(call BuildTarget))
