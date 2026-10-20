#
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

PLATFORM_ARCH = mips
PLATFORM_CROSS_COMPILE = $(shell \
        if grep -q ^CONFIG_CPU_LITTLE_ENDIAN $(KDIR)/.config && \
        which mips64el-octeon-linux-gnu-gcc > /dev/null 2>&1 ; then \
                echo -n mips64el-octeon-linux-gnu-; \
        else \
                echo -n mips64-octeon-linux-gnu-; fi)

PLATFORM_EXTRA_CFLAGS = -I$(KDIR)/drivers/net/ethernet/cavium/octeon/ \
					-I$(KDIR)/arch/mips/include/asm/octeon/ \
					-DOCTEON_MODEL=$(OCTEON_MODEL) \
					-I$(MODULE_TOPDIR)/platform/octeon/include \
					-I$(KDIR)/include/net

EXTRA_OBJS += platform/octeon/src/platform_api.o \
				platform/octeon/src/platform_input_qos.o \
				platform/octeon/src/platform_output_qos.o \
				platform/octeon/src/platform_bonding.o \
				platform/octeon/src/platform_xmit.o
				


