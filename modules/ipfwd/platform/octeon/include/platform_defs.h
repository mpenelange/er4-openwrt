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

#ifndef __PLATFORM_DEFS_H
#define __PLATFORM_DEFS_H

#include <asm/octeon/octeon-ethernet-user.h>
#include "ethernet-defines.h"
#include "octeon-ethernet.h"

#include <asm/octeon/cvmx.h>
#include <asm/octeon/cvmx-wqe.h>
#include <asm/octeon/cvmx-hwfau.h>
#include <asm/octeon/cvmx-ipd.h>
#include <asm/octeon/cvmx-pip.h>
#include <asm/octeon/cvmx-hwpko.h>
#include <asm/octeon/octeon-model.h>

#include <asm/octeon/cvmx-config.h>
#include <asm/octeon/cvmx-packet.h>
#include <asm/octeon/cvmx-wqe.h> 

/* depends on cvmx-pip.h */
#include <ethernet-defines.h>
#include <octeon-ethernet.h>

typedef cvm_oct_callback_result_t platform_callback_result_t;
typedef cvm_oct_callback_t platform_callback_t;

static inline struct net_device *platform_register_pkt_callback(const char *device_name, 
													platform_callback_t callback)
{
#if defined(CONFIG_OCTEON3_ETHERNET) || defined(CONFIG_OCTEON3_ETHERNET_MODULE)
	if (OCTEON_IS_MODEL(OCTEON_CN78XX) || OCTEON_IS_MODEL(OCTEON_CN73XX))
		return octeon3_register_callback(device_name, callback);
#endif

#if defined(CONFIG_OCTEON_ETHERNET) || defined(CONFIG_OCTEON_ETHERNET_MODULE)
	return cvm_oct_register_rx_callback(device_name, callback);
#endif

	return NULL;
}

#define platform_vlan_tx_tag_get		skb_vlan_tag_get

#define platform_vlan_tx_tag_present	skb_vlan_tag_present

#define PLATFORM_VLAN_HDR_IN_PKT	1

#ifdef CVM_IPFWD_MQUEUES_SUPPORT
#define platform_mq_register	cvm_mq_register
#define platform_mq_tx			cvm_mq_tx
#define platform_mq_unregister	cvm_mq_unregister
#endif

#define platform_free_work		cvm_oct_free_work

/* Flow Bucket  definitions */

/* Flow Entry */
typedef union {
	struct {
		u64 word0;
		u64 word1;
		u64 word2;
		u64 word3;
		u64 word4;
		u64 word5;
		u64 word6;
	} u;

	struct {
		/* Word 0 */
		u8	action;
		u8	ip_proto;
		u16	l4_sport;
		u16	pppoe_sid;
		u16	vlan_id;

		/* Word 1 */
		union {
			u64	ip_saddrhi;
			struct {
				u32 ip_saddr;
				u32 ip_daddr;
			};
		};

		/* Word 2, 3 and 4 */
		u64	ip_saddrlo;
		u64	ip_daddrhi;
		u64	ip_daddrlo;

		/* Word 5 */
		u8	id0     :4;
		u8	id1	:4;
		u8	cache_flush_stamp;
		u16	l4_dport;
		union {
			u32	vx_vni;
			u32 	gre_key;
		};

		/* Word 6 */
		u64	timestamp:28; /* update CVM_IPFWD_TIMER_GET_TIME if changed */
		u64	flow_info:36;

	} s;
} cvm_ipfwd_flow_entry_t;

/* Bucket header structure (64 bits) */
typedef struct {
	spinlock_t	wr_lock;        /* bucket lock */
	u16		reserved;
	u16		timestamp;      /* bucket timetamp */
} cvm_ipfwd_flow_bucket_header_t;

#define IPFWD_ENTRIES_PER_BUCKET	(CVMX_CACHE_LINE_SIZE/sizeof(cvm_ipfwd_flow_entry_t))
#define CVM_IPFWD_ENTRIES_PER_BUCKET	(IPFWD_ENTRIES_PER_BUCKET)

typedef struct {
	cvm_ipfwd_flow_bucket_header_t hdr;
	cvm_ipfwd_flow_entry_t         entry[CVM_IPFWD_ENTRIES_PER_BUCKET];
	u64 pad;
} cvm_ipfwd_flow_bucket_t;

#endif /* __PLATFORM_DEFS_H */
