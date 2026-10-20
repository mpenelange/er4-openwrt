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


//#include <linux/cache.h>
//#include <asm/barrier.h>
#include <linux/crc32.h>

#include "platform_api.h"

int platform_get_hash_bucket(struct sk_buff *skb, void *iph, struct tcphdr *th, 
								struct cvm_packet_info *cvm_info, bool ip6)
{
	u64 sdaddr;
	u32 saddr, daddr, sdport;
	u32 out_saddr, out_daddr;
	u16 out_sport, out_dport;
	u8 proto, out_proto;
	u32 gre_key;
	size_t len;
	u32 crc;

	if (skb->l4_hash) {
		crc = skb->hash;
	} else {

		crc = crc32(0, NULL, 0);
		if (ip6) {
			struct ipv6hdr *ip;
			len = sizeof(sdaddr);
			ip = (struct ipv6hdr *)iph;
			sdaddr = *(u64 *)&ip->saddr;
			crc = crc32(crc, &sdaddr, len);
			sdaddr = *((u64 *)&ip->saddr + 1);
			crc = crc32(crc, &sdaddr, len);
			proto = ip->nexthdr;
			crc = crc32(crc, &proto, 1);
		} else {
			struct iphdr *ip;
			ip = (struct iphdr *)iph;
			saddr = ip->saddr;
			crc = crc32(crc, &saddr, 4);
			daddr = ip->daddr;
			crc = crc32(crc, &daddr, 4);
			proto = ip->protocol;
			crc = crc32(crc, &proto, 1);
			sdport = *(u32*)&th->source;
			crc = crc32(crc, &sdport, 4);
		}

		if (cvm_info->rx_pkt_flags) {
			if (test_vlan_hdr(&cvm_info->rx_pkt_flags)) {
				int vlan_tci = cvm_info->vlan.h_vlan_TCI;	
				crc = crc32(crc, &vlan_tci, 4);
			}
			if (test_pppoe_hdr(&cvm_info->rx_pkt_flags)) {
				int pppoe_sid = cvm_info->pppoe.sid;
				crc = crc32(crc, &pppoe_sid, 4);
			}
			if (!ip6) {
				if (test_vxlan_hdr(&cvm_info->rx_pkt_flags)) {
					int vx_vni = cvm_info->vxlan.vx_vni;
					crc = crc32(crc, &vx_vni, 4);
					out_saddr = cvm_info->outer_ip4.saddr;	
					crc = crc32(crc, &out_saddr, 4);
					out_daddr = cvm_info->outer_ip4.daddr;
					crc = crc32(crc, &out_daddr, 4);
					out_proto = cvm_info->outer_ip4.protocol;
					crc = crc32(crc, &out_proto, 1);
					out_sport = cvm_info->outer_udp.source;
					crc = crc32(crc, &out_sport, 2);
					out_dport = cvm_info->outer_udp.dest;
					crc = crc32(crc, &out_dport, 2);
				}
			}
			if (test_gre_hdr(&cvm_info->rx_pkt_flags)) {
				out_saddr = cvm_info->outer_ip4.saddr;	
				crc = crc32(crc, &out_saddr, 4);
				out_daddr = cvm_info->outer_ip4.daddr;
				crc = crc32(crc, &out_daddr, 4);
				out_proto = cvm_info->outer_ip4.protocol;
				crc = crc32(crc, &out_proto, 1);
				if(cvm_info->gre.flags & GRE_KEY){
					gre_key = cvm_info->gre.key;
					crc = crc32(crc, &gre_key, 4);
				}
			}	
		}
	}
	if (ip6)
		return (crc & CVM_IPV6FWD_LUT_MASK);
	else
		return (crc & CVM_IPFWD_LUT_MASK);
}

int platform_get_hash_filter_bucket(filter_keys_t *fkeys)
{
	u8 proto = 0;
	u16 sport = 0, dport = 0;
	u32 mark = 0;
	u32 crc = crc32(0, NULL, 0);

	if (fkeys->flags & IPFWD_FILTER_PROTO)
		proto = fkeys->proto;
	if (fkeys->flags & IPFWD_FILTER_SPORT)
		sport = fkeys->sport;
	if (fkeys->flags & IPFWD_FILTER_DPORT)
		dport = fkeys->dport;
	if (fkeys->flags & IPFWD_FILTER_MARK)
		mark = fkeys->mark;

	crc = crc32(crc, &proto, 1);
	crc = crc32(crc, &sport, 2);
	crc = crc32(crc, &dport, 2);
	crc = crc32(crc, &mark, 4);

	return (crc & CVM_IPFWD_FILTER_LUT_MASK);
}

int platform_get_hash_frag_bucket(struct iphdr *ip) 
{
    uint64_t sdaddr;
    uint32_t frag_id;
    uint8_t proto;
    size_t len = sizeof(sdaddr);
    u32 crc = crc32(0, NULL, 0);

    sdaddr = *(uint64_t*)&ip->saddr;
    crc = crc32(crc, &sdaddr, len); //CVMX_MT_CRC_DWORD (sdaddr);
    frag_id = ip->id;
    crc = crc32(crc, &frag_id, 4); //CVMX_MT_CRC_WORD (frag_id);
    proto = ip->protocol;
    crc = crc32(crc, &proto, 1); //CVMX_MT_CRC_BYTE (proto);

	return (crc & CVM_IPFWD_LUT_MASK);
}

struct net_device *platform_register_pkt_callback(const char *device_name, 
													platform_callback_t callback) {

	/*
	 * This is a temporary hack for 83xx to avoid kernel crash triggered by watchdog timeout
	 * netdev->_tx->trans_start should be updated correctly by the module
	 * so that tx timeout is not triggered.
	 * This is not an issue on 81xx
	 */
	 													
	struct net_device* dev = dev_get_by_name(&init_net, device_name);
	
	netif_tx_lock_bh(dev);
	if(del_timer(&dev->watchdog_timer))
    	dev_put(dev);
	netif_tx_unlock_bh(dev);

	dev_put(dev);
	
	return NULL;
}

