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

#ifndef _IPFWD_H_
#define _IPFWD_H_

#include "ipfwd_common.h"

/* Ethernet header structure */
typedef struct {
    u32 enet_dst_hi;
    u16 enet_dst_lo;
    u16 enet_src_hi;
    u32 enet_src_lo;
    u16 enet_type;
} cvm_ipfwd_eh_t;

static inline void cvm_netif_tx_lock(struct netdev_queue *dev)
{
    spin_lock(&dev->_xmit_lock);
    dev->xmit_lock_owner = smp_processor_id();
}

static inline void cvm_netif_tx_unlock(struct netdev_queue *dev)
{
    dev->xmit_lock_owner = -1;
    spin_unlock(&dev->_xmit_lock);
}

#if 0
#define CVM_HARD_TX_LOCK(dev) {                 \
    if ((dev->features & NETIF_F_LLTX) == 0) {  \
        cvm_netif_tx_lock(dev);                 \
    }                                           \
}

#define CVM_HARD_TX_UNLOCK(dev) {               \
    if ((dev->features & NETIF_F_LLTX) == 0) {  \
        cvm_netif_tx_unlock(dev);               \
    }                                           \
}
#else
#define CVM_HARD_TX_LOCK(dev) {                 \
    cvm_netif_tx_lock(dev);                     \
}

#define CVM_HARD_TX_UNLOCK(dev) {               \
    cvm_netif_tx_unlock(dev);                   \
}
#endif

#define set_ipv4_bit(flags)		\
	set_bit(CVM_IPV4_BIT, &(flags))
#define clear_ipv4_bit(flags)		\
	clear_bit(CVM_IPV4_BIT, &(flags))
#define set_pppoe_ipv4_bit(flags)	\
	set_bit(CVM_IPV4_PPPOE_BIT, &(flags))
#define clear_pppoe_ipv4_bit(flags)	\
	clear_bit(CVM_IPV4_PPPOE_BIT, &(flags))
#define set_vlan_ipv4_bit(flags)	\
	set_bit(CVM_IPV4_VLAN_BIT, &(flags))
#define clear_vlan_ipv4_bit(flags)	\
	clear_bit(CVM_IPV4_VLAN_BIT, &(flags))
#define set_gre_ipv4_bit(flags)		\
	set_bit(CVM_IPV4_GRE_BIT, &(flags))
#define clear_gre_ipv4_bit(flags)	\
	clear_bit(CVM_IPV4_GRE_BIT, &(flags))
#define set_bonding_ipv4_bit(flags)		\
	set_bit(CVM_IPV4_BONDING_BIT, &(flags))
#define clear_bonding_ipv4_bit(flags)	\
	clear_bit(CVM_IPV4_BONDING_BIT, &(flags))
#define set_export_ipv4_bit(flags)		\
	set_bit(CVM_IPV4_EXPORT_BIT, &(flags))
#define clear_export_ipv4_bit(flags)	\
	clear_bit(CVM_IPV4_EXPORT_BIT, &(flags))

#define set_dpi_ipv4_bit(flags)		\
	set_bit(CVM_IPV4_DPI_BIT, &(flags))
#define clear_dpi_ipv4_bit(flags)	\
	clear_bit(CVM_IPV4_DPI_BIT, &(flags))

#define set_ipv6_bit(flags)		\
	set_bit(CVM_IPV6_BIT, &(flags))
#define clear_ipv6_bit(flags)		\
	clear_bit(CVM_IPV6_BIT, &(flags))
#define set_pppoe_ipv6_bit(flags)	\
	set_bit(CVM_IPV6_PPPOE_BIT, &(flags))
#define clear_pppoe_ipv6_bit(flags)	\
	clear_bit(CVM_IPV6_PPPOE_BIT, &(flags))
#define set_vlan_ipv6_bit(flags)	\
	set_bit(CVM_IPV6_VLAN_BIT, &(flags))
#define clear_vlan_ipv6_bit(flags)	\
	clear_bit(CVM_IPV6_VLAN_BIT, &(flags))
#define set_bonding_ipv6_bit(flags)	\
	set_bit(CVM_IPV6_BONDING_BIT, &(flags))
#define clear_bonding_ipv6_bit(flags)	\
	clear_bit(CVM_IPV6_BONDING_BIT, &(flags))

#ifdef CONFIG_UBNT_E300
extern struct net_device * cvm_oct_get_vlan_netdev(u16 vid);
#endif
extern platform_callback_result_t pkt_receive_cb(struct net_device *dev, void *wqe, struct sk_buff *skb);
extern u32 pkt_receive(struct sk_buff *skb);
extern int pkt_cache(struct sk_buff *skb);
extern int cvm_ipfwd_get_free_entry(cvm_ipfwd_flow_bucket_t *bucket, cvm_ipfwd_flow_entry_t **entry);
extern u32 gre_pkt_process(struct sk_buff *skb, cvmx_wqe_t *wqe,
                    struct ipv6hdr *ip,         
                    struct cvm_packet_info *cvm_info);
extern uint16_t gre_cvm_ipfwd_calculate_ip_header_checksum(uint16_t *ip);

#ifdef DPI
#define DPI_FINAL   0x01
#define DPI_NOINT   0x02
#define DPI_NOMORE  0x04

extern uint32_t is_app_int(uint8_t cat, uint16_t app);

extern int rx_dpi_1(struct sk_buff *skb, int ip_offset,
                           u8 *dpi_cat, u16 *dpi_app, u8 *dpi_flags);

extern int rx_dpi_2(struct sk_buff *skb, struct iphdr *ip,
                           u8 *dpi_cat, u16 *dpi_app, u8 *dpi_flags, u16 l2_len);

extern u8 tx_dpi(struct sk_buff *skb, struct iphdr *ip,
                         u8 *cat, u16 *app);
#endif

#endif /* _IPFWD_H_ */
