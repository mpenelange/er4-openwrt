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

#ifndef __PLATFORM_API_H
#define __PLATFORM_API_H

#include "ipfwd_common.h"

struct net_device *platform_register_pkt_callback(const char *device_name, platform_callback_t callback);

int platform_get_hash_bucket(struct sk_buff *skb, void *ip, struct tcphdr *th, struct cvm_packet_info *cvm_info, bool ip6);

int platform_set_bonding_fastpath(struct sk_buff *skb, unsigned long* pkt_flags, u8* oct_odev);
	
int platform_process_bonding_fastpath(struct sk_buff *skb);

/**
 *	platform_copy_l2 - Push l2 header into skb
 *	@skb: buffer
 *  @wqe: platform work queue entry
 *	@data: l2 header to be copied
 *  @len: length of @data
 *
 *	If headroom is not available then skbuff head is expanded.
 *
 *	Returns 0 if successful, -1 if skb head cannot be expanded.
 */
int platform_copy_l2(struct sk_buff *skb, cvmx_wqe_t *wqe, void *data, u16 len);

void platform_set_hw_ip_csum_compute(void  *work, bool flag);

int platform_skb_xmit(struct sk_buff *skb, cvmx_wqe_t *wqe, u8	oct_odev,
							int	ip_offset,
							int is_ipv6);

int platform_get_hash_filter_bucket(filter_keys_t *fkeys);

int platform_pop(u32 v);

int platform_supports_input_qos(void);

void platform_enable_input_qos(int ipd_red_avg_dly, 
								int ipd_red_prb_dly,
								int assured_pct, 
								int per_qos_pct);

void platform_disable_input_qos(void);

void platform_config_port_qos_watcher(int watcher, 
										int watcher_type, 
										u16 match_value, 
										u8 qos_level, 
										u16 mask);

int platform_input_qos_watcher_show(struct seq_file *s, void *v);

void platform_enable_qos_red(int assured_pct, int per_qos_pct);

void platform_backup_config_info(void);

void platform_enable_ipd_red(int ipd_red_avg_dly, int ipd_red_prb_dly);

int platform_supports_output_qos(void);

void platform_show_output_qos_config(void);

u32 platform_qos_output_map_get(struct sk_buff *skb, int* tx_queues);

int platform_get_hash_frag_bucket(struct iphdr *ip);

#ifdef CVM_IPFWD_MQUEUES_SUPPORT
int platform_mq_register(char *client);
int platform_mq_tx(uint32_t client_id, struct sk_buff *skb, uint32_t qnum);
void platform_mq_unregister(uint32_t client_id);
#endif

int platform_free_work(void *wqe);

#endif /* __PLATFORM_API_H */
