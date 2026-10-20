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

#ifndef __IPFWD_OUTPUT_QOS_H
#define __IPFWD_OUTPUT_QOS_H

#include "ipfwd_config.h"

#if (IPFWD_OUTPUT_QOS && IPFWD_ENABLE_QOS)
#include <linux/skbuff.h>
#include <linux/ip.h>
extern int ipfwd_output_qos_init(void);
extern void ipfwd_output_qos_exit(void);
extern int calculate_ipv4_skb_qos_level(struct sk_buff *skb, struct iphdr *ip);
extern void ipfwd_show_output_qos_config(void);
#else
#define ipfwd_output_qos_init()	0
#define ipfwd_output_qos_exit()	0
#define calculate_ipv4_skb_qos_level(skb, ip)	0
#define ipfwd_show_output_qos_config()	0
#endif
#endif /* __IPFWD_OUTPUT_QOS_H */
