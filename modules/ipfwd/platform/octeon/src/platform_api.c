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

#include <linux/cache.h>
#include <asm/barrier.h>
#include <linux/crc32.h>
#include <linux/siphash.h>
#include <linux/net.h>

#include "platform_api.h"

/*
 * Flow cache bucket index. This used to be the CPU's CRC unit (CRC32C, fixed
 * IV) over the tuple: unkeyed and linear, so anyone could compute tuples that
 * share a bucket with a victim flow and keep evicting it to the slow path
 * (a targeted denial of service). A random CRC IV would not help: for
 * equal-length inputs the IV cancels out of the XOR of two CRCs. Use the
 * kernel's keyed hsiphash with a per-boot random key, as mainline does for
 * conntrack.
 */
static hsiphash_key_t ipfwd_hash_key __read_mostly;

int platform_get_hash_bucket(struct sk_buff *skb, void *iph, struct tcphdr *th, 
								struct cvm_packet_info *cvm_info, bool ip6)
{
	u32 w[16];
	int n = 0;
	u32 idx;

	net_get_random_once(&ipfwd_hash_key, sizeof(ipfwd_hash_key));

	if (ip6) {
		struct ipv6hdr *ip = (struct ipv6hdr *)iph;

		memcpy(&w[n], &ip->saddr, 16);
		n += 4;
		memcpy(&w[n], &ip->daddr, 16);
		n += 4;
		w[n++] = ip->nexthdr;
	} else {
		struct iphdr *ip = (struct iphdr *)iph;

		w[n++] = ip->saddr;
		w[n++] = ip->daddr;
		w[n++] = ip->protocol;
	}
	w[n++] = *(u32 *)&th->source;	/* source and destination port */

	if (cvm_info->rx_pkt_flags) {
		if (test_vlan_hdr(&cvm_info->rx_pkt_flags))
			w[n++] = cvm_info->vlan.h_vlan_TCI;
		if (test_pppoe_hdr(&cvm_info->rx_pkt_flags))
			w[n++] = cvm_info->pppoe.sid;
		if (!ip6 && test_vxlan_hdr(&cvm_info->rx_pkt_flags)) {
			w[n++] = cvm_info->vxlan.vx_vni;
			w[n++] = cvm_info->outer_ip4.saddr;
			w[n++] = cvm_info->outer_ip4.daddr;
			w[n++] = (cvm_info->outer_ip4.protocol << 16) ^ cvm_info->outer_udp.source;
			w[n++] = cvm_info->outer_udp.dest;
		}
		if (test_gre_hdr(&cvm_info->rx_pkt_flags)) {
			w[n++] = cvm_info->outer_ip4.saddr;
			w[n++] = cvm_info->outer_ip4.daddr;
			w[n++] = cvm_info->outer_ip4.protocol;
			if (cvm_info->gre.flags & GRE_KEY)
				w[n++] = cvm_info->gre.key;
		}
	}

	idx = hsiphash(w, n * sizeof(u32), &ipfwd_hash_key);

	if (ip6)
		return (idx & CVM_IPV6FWD_LUT_MASK);
	else
		return (idx & CVM_IPFWD_LUT_MASK);
}

int platform_get_hash_filter_bucket(filter_keys_t *fkeys)
{
	int idx;
	u8 proto = 0;
	u16 sport = 0, dport = 0;
	u32 mark = 0;

	set_c0_status(ST0_CU2);
	
	if (fkeys->flags & IPFWD_FILTER_PROTO)
		proto = fkeys->proto;
	if (fkeys->flags & IPFWD_FILTER_SPORT)
		sport = fkeys->sport;
	if (fkeys->flags & IPFWD_FILTER_DPORT)
		dport = fkeys->dport;
	if (fkeys->flags & IPFWD_FILTER_MARK)
		mark = fkeys->mark;

	CVMX_MT_CRC_POLYNOMIAL(0x1edc6f41);
	CVMX_MT_CRC_IV(0);
	CVMX_MT_CRC_BYTE(proto);
	CVMX_MT_CRC_WORD(sport);
	CVMX_MT_CRC_WORD(dport);
	CVMX_MT_CRC_DWORD(mark);

	CVMX_MF_CRC_IV(idx);

	return (idx & CVM_IPFWD_FILTER_LUT_MASK);
}

int platform_get_hash_frag_bucket(struct iphdr *ip) 
{
    uint64_t sdaddr;
    uint32_t frag_id;
    uint8_t proto;
    int idx;

    set_c0_status(ST0_CU2);

    proto=ip->protocol;

    CVMX_MT_CRC_POLYNOMIAL (0x1edc6f41);
    CVMX_MT_CRC_IV (0);
    sdaddr = *(uint64_t*)&ip->saddr;
    CVMX_MT_CRC_DWORD (sdaddr);
    frag_id = ip->id;
    CVMX_MT_CRC_WORD (frag_id);
    CVMX_MT_CRC_BYTE (proto);
    CVMX_MF_CRC_IV (idx);

    return (idx & CVM_IPFWD_LUT_MASK);
}

