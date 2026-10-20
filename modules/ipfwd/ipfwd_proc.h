/**********************************************************************
* Author: Cavium, Inc.
*
* Contact: support@cavium.com
*          Please include "ipfwd-offload" in the subject.
*
* Copyright (c) 2003-2016 Cavium, Inc.
*
* This file is free software; you can redistribute it and/or modify
* it under the terms of the GNU General Public License, Version 2, as
* published by the Free Software Foundation.
*
* This file is distributed in the hope that it will be useful, but
* AS-IS and WITHOUT ANY WARRANTY; without even the implied warranty
* of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE, TITLE, or
* NONINFRINGEMENT.  See the GNU General Public License for more details.
***********************************************************************/

#ifndef __IPFWD_PROC_H
#define __IPFWD_PROC_H

#include "ipfwd_compat.h"
#include <linux/proc_fs.h>

/* common prefix used by pr_<> macros */
//#undef pr_fmt
//#define pr_fmt(fmt)	KBUILD_MODNAME ": " fmt

struct l3_proc {
	struct proc_dir_entry *dir;	
	struct proc_dir_entry *fwd;
	struct proc_dir_entry *pppoe;
	struct proc_dir_entry *vlan;
	struct proc_dir_entry *gre;
	struct proc_dir_entry *bonding;
	struct proc_dir_entry *cache_size;
	struct proc_dir_entry *cache;
	struct proc_dir_entry *ignore_cache_flush;
#ifdef FLOW_COUNTERS
        struct proc_dir_entry *export;
#endif
#ifdef DPI
        struct proc_dir_entry *dpi;
#endif
};

struct ipfwd_proc_info {
	struct proc_dir_entry *dir;
	struct proc_dir_entry *fwd;
	struct proc_dir_entry *debug;
	struct proc_dir_entry *filter;
	struct proc_dir_entry *stats;
#ifdef CVM_IPFWD_MQUEUES_SUPPORT
	struct proc_dir_entry *cvm_mq;
#endif
	struct l3_proc ipv4;
	struct l3_proc ipv6;
};

extern struct ipfwd_proc_info ipfwd_proc;

typedef struct {
	const char			*name;
	umode_t				mode;
	const struct ipfwd_proc_ops	*proc_fops;	
} ipfwd_proc_entry_t;

enum ipfwd_status {
	CVM_IP_BIT = 0,
	CVM_IPV4_BIT = 1,
	CVM_IPV4_PPPOE_BIT = 2,
	CVM_IPV4_VLAN_BIT = 3,
	CVM_IPV4_GRE_BIT = 4,
	CVM_IPV4_BONDING_BIT = 5,
	CVM_IPV6_BIT = 6,
	CVM_IPV6_PPPOE_BIT = 7,
	CVM_IPV6_VLAN_BIT = 8,
	CVM_IPV6_BONDING_BIT = 9,
	CVM_INPUT_QOS_BIT = 10,
	CVM_IPV4_EXPORT_BIT = 11,
	CVM_IPV4_DPI_BIT = 12,
};

extern unsigned long ipfwd_flags;

extern int cvm_init_common_proc(void);
extern void cvm_clean_common_proc(void);
extern void dump_buffer(const void *buf, size_t len);
extern void dump_buffer_str(const char *str, const void *buf, size_t len);

#ifdef CONFIG_PROC_FS
/* ipfwd.c */
extern void cvm_ipfwd_invalidate(void);
extern long cvm_ipfwd_invalidation_count(void);

extern int ipfwd_add_proc_entries(struct proc_dir_entry *dir, ipfwd_proc_entry_t *ent, void *data);
extern void ipfwd_remove_proc_entries(struct proc_dir_entry *dir, ipfwd_proc_entry_t *ent);
#else
#define ipfwd_add_proc_entries(dir, ent, data)
#define ipfwd_remove_proc_entries(dir, ent)
#endif

#if !IPFWD_ENABLE_STATS
#define update_ipfwd_stats(in_flow, out_flow, return_status, bad_checksum, in_bytes, out_bytes)
#define incr_ipfwd_flow_stat(counter)
#else
enum ipfwd_flow_stats {
	/* low_level_ip_pkt_process() - IPv4 */
	IPV4_FLOW_FOUND,
	IPV4_FLOW_FOUND_EXPIRED,
	IPV4_FLOW_FOUND_OLD_RANDOM_BYPASS,
	IPV4_FLOW_FOUND_ACTION_BYPASS,
	IPV4_FLOW_NOT_FOUND,

	/* cvm_ipfwd_ip_cache_flow() - IPv4 */
	IPV4_CREATE_FLOW_FOUND,
	IPV4_CREATE_FLOW_FOUND_REPLACED,
	IPV4_CREATE_FLOW_NOT_FOUND,
	IPV4_CREATE_FLOW_NOT_FOUND_JUST_CREATED,
	IPV4_CREATE_FLOW_NOT_FOUND_REPLACED_EXPIRED,
	IPV4_CREATE_FLOW_NOT_FOUND_REPLACED_NON_EXPIRED,

	/* low_level_ip_pkt_process() - IPv6*/
	IPV6_FLOW_FOUND,
	IPV6_FLOW_FOUND_EXPIRED,
	IPV6_FLOW_FOUND_OLD_RANDOM_BYPASS,
	IPV6_FLOW_FOUND_ACTION_BYPASS,
	IPV6_FLOW_NOT_FOUND,

	/* cvm_ipfwd_ip_cache_flow() - IPv6 */
	IPV6_CREATE_FLOW_FOUND,
	IPV6_CREATE_FLOW_FOUND_REPLACED,
	IPV6_CREATE_FLOW_NOT_FOUND,
	IPV6_CREATE_FLOW_NOT_FOUND_JUST_CREATED,
	IPV6_CREATE_FLOW_NOT_FOUND_REPLACED_EXPIRED,
	IPV6_CREATE_FLOW_NOT_FOUND_REPLACED_NON_EXPIRED,

	IPV4_FLUSHES,
	IPV6_FLUSHES,

	IPFWD_FLOW_STATS_SIZE
};

void update_ipfwd_stats(u16 in_flow, u16 out_flow, int return_status, bool bad_checksum, unsigned long in_bytes, unsigned long out_bytes);
void incr_ipfwd_flow_stat(enum ipfwd_flow_stats counter);

#endif

#endif /* __IPFWD_PROC_H */
