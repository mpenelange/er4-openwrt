# Author: Cavium, Inc.
#
# Contact: support@cavium.com
#          Please include "ipfwd-offload" in the subject.
#
# Copyright (c) 2003-2016 Cavium, Inc.
#
# This file is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License, Version 2, as
# published by the Free Software Foundation.
#
# This file is distributed in the hope that it will be useful, but
# AS-IS and WITHOUT ANY WARRANTY; without even the implied warranty
# of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE, TITLE, or
# NONINFRINGEMENT.  See the GNU General Public License for more details.
#
KDIR := $(KERNEL_SRC_DIR)
CAVIUM_PLATFORM := octeon

ifeq ($(strip $(KDIR)), )
$(error "Please define KDIR")
endif

ifeq ($(strip $(CAVIUM_PLATFORM)), )
$(error "Please define CAVIUM_PLATFORM")
endif

ifeq ($(strip $(MODULE_TOPDIR)), )
export MODULE_TOPDIR=$(shell pwd)
$(info Setting MODULE_TOPDIR to $(MODULE_TOPDIR))
endif

# Platform Makefiles will define following variables
# PLATFORM_ARCH, PLATFORM_CROSS_COMPILE, PLATFORM_EXTRA_CFLAGS

# Platform Makefile will add extra objs if needed
# EXTRA_OBJS
include $(MODULE_TOPDIR)/platform/$(CAVIUM_PLATFORM)/Makefile

ifeq ($(strip $(CROSS_COMPILE)), )
export CROSS_COMPILE = $(strip $(PLATFORM_CROSS_COMPILE))
$(info Setting CROSS_COMPILE to $(CROSS_COMPILE))
endif

ifeq ($(strip $(STRIP)), )
export STRIP=${CROSS_COMPILE}strip
$(info Setting STRIP to $(STRIP))
endif

ifeq ($(strip $(ARCH)), )
export ARCH=$(PLATFORM_ARCH)
$(info Setting ARCH to $(ARCH))
endif

ccflags-y += -Winline \
			-Wall \
			-I$(KDIR)/include \
			-I$(KDIR)/fs/proc/ \
			-I$(KDIR)/ \
			$(PLATFORM_EXTRA_CFLAGS) \
			-I$(MODULE_TOPDIR) \
			-I$(MODULE_TOPDIR)/platform/include

# Common flags to be passed for driver compilation
ccflags-y += -I$(PWD)/include

# Either enable CVM_QOS_OUTPUT_QOS or CVM_IPFWD_MQUEUES_SUPPORT, but not both at a time

#ccflags-y += -DCVM_IPFWD_MQUEUES_SUPPORT            # Support for multiple queues

#ccflags-y += -DCVM_IPFWD_FRAG_SUPPORT
#EXTRA_OBJS  += ipfrag.o

ccflags-y += -DIPFWD_ENABLE_QOS=0
#ccflags-y += -DIPFWD_ENABLE_QOS=1
#EXTRA_OBJS += ipfwd_input_qos.o ipfwd_output_qos.o

ccflags-y += -DIPFWD_ENABLE_FILTER=0
#ccflags-y += -DIPFWD_ENABLE_FILTER=1
#EXTRA_OBJS  += ipfwd_filter.o

# debug prints disabled
#ccflags-y += -DDEBUG -DCONFIG_PROC_FS

# pppoe support
ccflags-y += -DIPFWD_IPV4_PPPOE -DIPFWD_IPV6_PPPOE

# bonding support
ccflags-y += -DIPFWD_IPV4_BONDING -DIPFWD_IPV6_BONDING

# per flow pkt/byte counters
ccflags-y += -DFLOW_COUNTERS

# DPI: needs UBNT's proprietary ubnt_nf_app.ko (Trend Micro engine), not available here
#ccflags-y += -DDPI

# version number (major.minor)
ccflags-y += -DMAJOR_NUMBER=6 -DMINOR_NUMBER=1

# STATS
ccflags-y += -DIPFWD_ENABLE_STATS=1

# Test builds only: poison flow_info buffers when freed (make IPFWD_POISON=1)
ifeq ($(IPFWD_POISON),1)
ccflags-y += -DIPFWD_DEBUG_POISON
endif

EXTRA_OBJS += export.o

obj-m := cavium-ip-offload.o
cavium-ip-offload-objs := ipfwd.o \
							ipfwd_proc.o \
							$(EXTRA_OBJS)

all: module

module: links
	$(MAKE) -C $(KDIR) M=$(PWD) modules

links:

clean:
	make -C $(KDIR) M=$(PWD) clean
	rm -rf modules.order Module.symvers .tmp_versions

install:
	INSTALL_MOD_STRIP=--strip-unneeded INSTALL_MOD_PATH=$(DESTDIR) \
		$(MAKE) -C $(KDIR) M=$(PWD) modules_install
	rm -f $(DESTDIR)/lib/modules/*/modules.*

check:
