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

#ifndef __IPFWD_COMMON_H
#define __IPFWD_COMMON_H

#include <linux/if_ether.h>
#include <linux/if.h>
#include <linux/if_arp.h>
#include <net/gre.h>
#include <linux/if_pppox.h>
#include <linux/if_vlan.h>

#include "bonding.h"
#include "platform_defs.h"

#include "ipfwd_filter.h"


enum ipfwd_ret_code {
	CVM_IPFWD_RET_FAILED 			= CVM_OCT_PASS,
	CVM_IPFWD_RET_SUCCESS_SLOW		= CVM_OCT_TAKE_OWNERSHIP_SKB,
	CVM_IPFWD_RET_SUCCESS_FAST		= CVM_OCT_TAKE_OWNERSHIP_WORK,
};

/* Return code for "not found" */
#define CVM_IPFWD_NOT_FOUND	-1

/* Number of retries for reads */
#define CVM_IPFWD_ENTRY_RETRIES	5

enum entry_state {
	CVM_IPFWD_EXPIRED,
	CVM_IPFWD_NEW,
	CVM_IPFWD_OLD,
};

/* cvm_ipfwd_flow_entry_t and cvm_ipv6fwd_flow_entry_t define timestamp as 28-bit field. */
#define CMV_IPFWD_TIMER_MAX		0x0FFFFFFF
#define CVM_IPFWD_TIMER_GET_TIME        (jiffies & CMV_IPFWD_TIMER_MAX)

extern u64 CVM_IPFWD_TIMER_NEW_LIFETIME;
extern u64 CVM_IPFWD_TIMER_OLD_LIFETIME;

#define CVM_IPFWD_TIMER_TOTAL_LIFETIME  (CVM_IPFWD_TIMER_NEW_LIFETIME + CVM_IPFWD_TIMER_OLD_LIFETIME)

/* cycle counter shift count (for random_select()) */
#define CVM_IPFWD_RND_SHIFT	1

/* cycle counter AND mask (for random_select()) */
#define CVM_IPFWD_RND_MSK	0x1F

/* cycle counter compare value (for random_select()) */
#define CVM_IPFWD_RND_VAL	1

#ifndef VXLAN_HEADROOM
/* IP header + UDP + VXLAN + Ethernet header */
#define VXLAN_HEADROOM (20 + 8 + 8 + 14)
#endif

#ifndef VXLAN6_HEADROOM
/* IPv6 header + UDP + VXLAN + Ethernet header */
#define VXLAN6_HEADROOM (40 + 8 + 8 + 14)
#endif

#define VXLAN_DST_PORT 4789

#define L2_MAX_HDR_LEN	(ETH_HLEN + VLAN_HLEN + PPPOE_SES_HLEN + VXLAN6_HEADROOM)	

#define IPFWD_COOKIE_VALUE	0xDEADBEEF

enum pkt_flags {
	CVM_VLAN_HDR,
	CVM_PPPOE_SES_HDR,	
	CVM_VXLAN_HDR,
	CVM_GRE_HDR,
	CVM_BONDING_FASTPATH
};

#define set_vlan_hdr(flags)			\
	set_bit(CVM_VLAN_HDR, (flags))
#define clear_vlan_hdr(flags)			\
	clear_bit(CVM_VLAN_HDR, (flags))
#define test_vlan_hdr(flags)			\
	test_bit(CVM_VLAN_HDR, (flags))
#define set_pppoe_hdr(flags)			\
	set_bit(CVM_PPPOE_SES_HDR, (flags))
#define clear_pppoe_hdr(flags)			\
	clear_bit(CVM_PPPOE_SES_HDR, (flags))
#define test_pppoe_hdr(flags)			\
	test_bit(CVM_PPPOE_SES_HDR, (flags))
#define set_vxlan_hdr(flags)			\
	set_bit(CVM_VXLAN_HDR, (flags))
#define clear_vxlan_hdr(flags)			\
	clear_bit(CVM_VXLAN_HDR, (flags))
#define test_vxlan_hdr(flags)			\
	test_bit(CVM_VXLAN_HDR, (flags))

#define set_gre_hdr(flags)			\
	set_bit(CVM_GRE_HDR, (flags))
#define clear_gre_hdr(flags)			\
	clear_bit(CVM_GRE_HDR, (flags))
#define test_gre_hdr(flags)			\
	test_bit(CVM_GRE_HDR, (flags))

#define set_bonding_fastpath(flags)			\
	set_bit(CVM_BONDING_FASTPATH, (flags))
#define clear_bonding_fastpath(flags)			\
	clear_bit(CVM_BONDING_FASTPATH, (flags))
#define test_bonding_fastpath(flags)			\
	test_bit(CVM_BONDING_FASTPATH, (flags))

extern struct net_device *dev_table[];
extern u8 cvm_gbl_ipfwd_cache_flush_stamp;

#ifdef CVM_QOS_POLICER

#define CVM_QOS_NUM_POLICERS_MAX              8
#define CVM_QOS_TB_SCALE_FACTOR_BIT_SHIFT     16
#define CVM_QOS_TB_SCALE_FACTOR               (1 << CVM_QOS_TB_SCALE_FACTOR_BIT_SHIFT)
#define CVM_QOS_MTU                           1500
#define CVM_QOS_TB_DEPTH                      (5 * CVM_QOS_MTU)   /* Max Token Bucket depth = 5 * MTU */
#define CVM_QOS_POLICER_CRC_LEN               4
#define CVM_QOS_POLICER_ETHERNET_HEADER_LEN   18

typedef struct _cvm_qos_token_bucket
{
    u64   rate_in_kbps_cfg;
    u64   rate_in_cycles_per_byte;
    u64   rate_in_kbps;

    u64   depth_in_bytes_cfg;
    u64   depth_in_cycles;
    u64   depth_in_bytes;

    u64   cycles_prev;
    u64   cycles_curr;
} cvm_qos_token_bucket_t;

typedef struct _cvm_qos_policer_stats
{
    u64   pkts_pass;
    u64   pkts_drop;
    u64   bytes_pass;
    u64   bytes_drop;
} cvm_qos_policer_stats_t;

typedef struct _cvm_qos_policer
{
    spinlock_t                lock;
    u8                        is_policer_on;
    cvm_qos_token_bucket_t    tb;
    cvm_qos_policer_stats_t   stats;
    int32_t                   bytes_offset;
} cvm_qos_policer_t;

extern cvm_qos_policer_t  cvm_qos_policer[CVM_QOS_NUM_POLICERS_MAX];
extern u64           cvm_qos_tb_rate_const_scaled;

extern int  cvm_qos_rate_limit (int32_t bytes, uint8_t policer_num);
extern u64 octeon_get_clock_rate(void);

#endif /* CVM_QOS_POLICER */
#ifdef FLOW_COUNTERS
struct ipfwd_counter {
	atomic_long_t	packets;
	atomic_long_t	bytes;
};
#endif

extern unsigned int ipv4_cache_size; /* Number of hash buckets for ipv4 in the flow LUT (module param, must be power of 2) */
#define CVM_IPFWD_LUT_MASK	(ipv4_cache_size - 1)
#define CVM_IPFWD_LUT_DEFAULT	8192
#define CVM_IPFWD_LUT_MAX	32768

/**
 * cvm_ipfwd_flow_info_t - flow info (referenced by flow entry)
 * @flow_label: flow type (ipv4/v6, pppoe or vlan etc)
 * @flow_mtu: flow mtu size
 * @action: flow action (bypass etc)
 * @pkt_type: flow packet type (used to set wqe unused field to determine ipoffset)
 * @l2_hdr: L2 header for the outgoing packet
 * @l2_len: L2 header length
 * @ip_proto: ip protocol
 * @ip_saddr: ip source address
 * @ports: L4 ports
 * @ip_tos:
 * @dev: outgoing net device
 * @rx_ifindex: ifindex of the physical port the flow arrives on; hits from any other port go to the slow path
 * @oct_dev:
 * @pkts_rcvd: packets rcvd on this flow.
 * @pkts_send: packets send on this flow.
 */
typedef struct {
	unsigned long pkt_flags;
	u16	out_flow;
	u32	mtu;
	u8	action;
	u8	l2_hdr[L2_MAX_HDR_LEN];
	u16	l2_len;
	int	ip_offset;
	int	pppoe_offset;
	int	l4_offset;
	u16	ip_proto;
	union {
		struct {
			u32	ip_saddr;
			u32	ip_daddr;
		};
		u64	ip_saddrhi;
	};
	u64	ip_saddrlo;
	u64	ip_daddrhi;
	u64	ip_daddrlo;
	u32	ports;
	u16	vlan_proto;
	u16	vlan_tag;
	u8	ip_tos;
#ifdef CVM_QOS_POLICER
	u8	nfmark;
#endif
	struct net_device	*dev;
	int	rx_ifindex;	/* physical port the flow was learned on */
	u8	oct_odev;
#ifdef DPI
	u8	dpi_cat;
	u16	dpi_app;
	u8	dpi_flags;
	u8	pad;
#endif
#ifdef FLOW_COUNTERS
	struct ipfwd_counter	rx;
	struct ipfwd_counter	tx;
#endif
	struct net_device	*cache_show_dev_rx;
	struct net_device	*cache_show_dev_tx;
	struct rcu_head	rcu;	/* freed after an RCU grace period: the fast path reads it locklessly */
} cvm_ipfwd_flow_info_t;

extern int ipv6_cache_size; /* Number of hash buckets for ipv6 in the flow LUT (module param, must be power of 2) */
#define CVM_IPV6FWD_LUT_MASK	(ipv6_cache_size - 1)
#define CVM_IPV6FWD_LUT_DEFAULT	8192
#define CVM_IPV6FWD_LUT_MAX	32768

#include <asm/octeon/cvmx.h>
#include <asm/octeon/cvmx-pip.h>
#include <ethernet-defines.h>

static inline int _is_oct_dev(struct net_device *dev)
{
	return dev->is_cvm_dev;
}

#ifdef DEBUG
#define IPFWD_CACHE_SHOW 1
#else /* DEBUG */
#define IPFWD_CACHE_SHOW 1
#endif /* DEBUG */

enum {
	CVM_QOS_ERR		= 0,
	CVM_QOS_WACTHER		= (1 << 0),
	CVM_WATCHER_TYPE	= (1 << 1),
	CVM_MATCH_VALUE		= (1 << 2),
	CVM_QOS_LEVEL		= (1 << 3),
	CVM_QOS_MASK		= (1 << 4),
};

#include "platform_api.h"

#ifdef CONFIG_NETFILTER
#include <net/netfilter/nf_conntrack.h>
#include <net/netfilter/nf_conntrack_helper.h>
#endif

#endif /* __IPFWD_COMMON_H */
