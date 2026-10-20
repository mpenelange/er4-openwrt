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

#ifndef _IPFRAG_H_
#define _IPFRAG_H_

int cvm_ipfwd_frag_cache_flow(struct sk_buff *skb, struct cvm_packet_info *info);
extern u32 ipv4_frag_pkt_rcv(struct sk_buff *skb, cvmx_wqe_t *wqe, struct cvm_packet_info *cvm_info);
int cvm_ipfwd_frag_cache_firstfrag(struct sk_buff *skb, struct iphdr *ip_first, cvm_ipfwd_flow_info_t *info);
#endif

