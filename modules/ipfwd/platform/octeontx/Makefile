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

PLATFORM_ARCH = arm64
PLATFORM_CROSS_COMPILE = $(shell echo -n aarch64-thunderx-linux-gnu-)
PLATFORM_EXTRA_CFLAGS = -I$(MODULE_TOPDIR)/platform/octeontx/include \
						-I$(KDIR)/include/net/

EXTRA_OBJS += platform/octeontx/src/platform_api.o
