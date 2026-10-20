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

#include <linux/cache.h>

/**
 * enum cvm_oct_callback_result -  Return codes for the Ethernet* driver intercept callback.
 *
 * Depending on the return code, the ethernet driver will continue
 * processing in different ways.
 */
enum platform_callback_result {
	CVM_OCT_PASS,               /**< The ethernet driver will pass the packet
					to the kernel, just as if the intercept
					callback didn't exist */
	CVM_OCT_DROP,               /**< The ethernet driver will drop the packet,
					cleaning of the work queue entry and the
					skbuff */
	CVM_OCT_TAKE_OWNERSHIP_WORK,/**< The intercept callback takes over
					ownership of the work queue entry. It is
					the responsibility of the callback to free
					the work queue entry and all associated
					packet buffers. The ethernet driver will
					dispose of the skbuff without affecting the
					work queue entry */
	CVM_OCT_TAKE_OWNERSHIP_SKB  /**< The intercept callback takes over
					ownership of the skbuff. The work queue
					entry and packet buffer will be disposed of
					in a way keeping the skbuff valid */
};
typedef enum platform_callback_result platform_callback_result_t;

/**
 * cvm_oct_callback_result_t -  Ethernet driver intercept callback hook type.
 *
 * The callback receives three parameters and returns a struct
 * cvm_oct_callback_result code.
 *
 * The first parameter is the linux device for the ethernet port the
 * packet came in on.
 *
 * The second parameter is the raw work queue entry from the hardware.
 *
 * The third parameter is the packet converted into a Linux skbuff.
 */
typedef platform_callback_result_t (*platform_callback_t)(struct net_device *dev,
							void *work_queue_entry,
							struct sk_buff *skb);


struct cvmx_wqe {
	u32 word;
	union {
		union {
			int bufs;
		}s;
	}word2;
};
typedef struct cvmx_wqe cvmx_wqe_t;

#define IPFWD_FPA_PACKET_POOL_SIZE		4096

#define CVMX_CACHE_LINE_SIZE			128

#define TOTAL_NUMBER_OF_PORTS			16

#define CVMX_SYNC						smp_mb__after_atomic()

#define CVMX_SYNCW 						smp_mb__after_atomic()

#define CVMX_SYNCWS						wmb()

#define cvmx_wait						__delay

#define cvmx_get_cycle					get_cycles

#define cvmx_unlikely					unlikely

#define cvmx_likely						likely

#define platform_vlan_tx_tag_get		skb_vlan_tag_get

#define platform_vlan_tx_tag_present	skb_vlan_tag_present

#define PLATFORM_VLAN_HDR_IN_PKT	0

static inline int platform_is_oct_dev(const char* device_name) {
	return 0;
}

static inline int platform_set_bonding_fastpath(struct sk_buff *skb, 
												unsigned long* pkt_flags, 
												u8* oct_odev) 
{
	return 0;
}

static inline int platform_process_bonding_fastpath(struct sk_buff *skb) 
{
	return 0;
}

static inline int platform_copy_l2(struct sk_buff *skb, cvmx_wqe_t *wqe, void *data, u16 len) 
{

	if (skb_cow_head(skb, len))
		return -1;

	/*
	 * __skb_push
	 */
	skb->data = ((u8 *)skb->data - len);
	skb->len += len;

	/*
	 * copy data
	 */
	memcpy(skb->data, data, len);
	
	return 0;
}	

static inline void platform_set_hw_ip_csum_compute(void  *work, bool flag) 
{

}

static inline int platform_skb_xmit(struct sk_buff *skb, 
									cvmx_wqe_t *wqe, 
									u8	oct_odev,
									int	ip_offset,
									int is_ipv6) 
{
	int rc = NETDEV_TX_BUSY;
	struct net_device *dev = skb->dev;
	const struct net_device_ops *ops = dev->netdev_ops;
	struct netdev_queue *txq;
	struct sock *sk = skb->sk;
	int cpu = smp_processor_id();
	int queue_index = skb_rx_queue_recorded(skb) ? 
						skb_get_rx_queue(skb) : sk_tx_queue_get(sk);

	if (queue_index < 0 || skb->ooo_okay ||
		queue_index >= dev->real_num_tx_queues) {

		int new_index = skb_tx_hash(dev, skb);

		if (queue_index != new_index && sk &&
		    sk_fullsock(sk) &&
		    rcu_access_pointer(sk->sk_dst_cache))
		        sk_tx_queue_set(sk, new_index);

		queue_index = new_index;
	}

	skb_set_queue_mapping(skb, queue_index);
	txq = netdev_get_tx_queue(dev, queue_index);

	HARD_TX_LOCK(dev, txq, cpu);
	if (!netif_tx_queue_stopped(txq)) {
		if ((rc = ops->ndo_start_xmit(skb, dev)) == NETDEV_TX_OK) {
			txq->trans_start = jiffies;
		}
	}
	HARD_TX_UNLOCK(dev, txq);

	if(rc == NETDEV_TX_BUSY)
		__kfree_skb(skb);

	return CVM_OCT_TAKE_OWNERSHIP_SKB;
}

static inline int platform_supports_input_qos(void) 
{
	return 0;
}

static inline void platform_enable_input_qos(int ipd_red_avg_dly, 
								int ipd_red_prb_dly,
								int assured_pct, 
								int per_qos_pct) 
{

}

static inline void platform_disable_input_qos(void) 
{

}

static inline void platform_config_port_qos_watcher(int watcher, 
										int watcher_type, 
										u16 match_value, 
										u8 qos_level, 
										u16 mask) 
{

}

static inline int platform_input_qos_watcher_show(struct seq_file *s, void *v) 
{
	return 0;
}

static inline void platform_enable_qos_red(int assured_pct, int per_qos_pct) 
{

}

static inline void platform_backup_config_info(void)
{

}

static inline void platform_enable_ipd_red(int ipd_red_avg_dly, int ipd_red_prb_dly) 
{

}

static inline int platform_supports_output_qos(void) 
{
	return 0;
}

static inline u32 platform_qos_output_map_get(struct sk_buff *skb, int* tx_queues)
{
	return 0;
}

static inline void platform_show_output_qos_config(void)
{
}

static inline int platform_free_work(void *wqe)
{
	kfree(wqe);
	return 0;
}

static inline int cvmx_pop(u32 v) {
	int c;
	for (c = 0; v; v >>= 1)
		c += v & 1;
	return c;	
}

#ifdef CVM_IPFWD_MQUEUES_SUPPORT
static inline int platform_mq_register(char *client)
{
	return 0;
}

static inline int platform_mq_tx(uint32_t client_id, struct sk_buff *skb, uint32_t qnum)
{
	return 0;
}

static inline void platform_mq_unregister(uint32_t client_id)
{
}
#endif

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
		u64	timestamp:28;
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
} cvm_ipfwd_flow_bucket_t;

#endif /* __PLATFORM_DEFS_H */
