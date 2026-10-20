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

#include "platform_api.h"

static inline void cvm_oct_set_back(struct sk_buff *skb,
                                    union cvmx_buf_ptr *hw_buffer)
{
	unsigned char *fpa_head = cvm_oct_get_fpa_head(skb);

	hw_buffer->s.back = ((unsigned long)skb->data >> 7) - ((unsigned long)fpa_head >> 7);
}

static inline bool cvm_oct_skb_ok_for_reuse(struct sk_buff *skb)
{
	unsigned char *fpa_head = cvm_oct_get_fpa_head(skb);

 	int buffers_to_free = cvmx_hwfau_fetch_and_add32(FAU_NUM_PACKET_BUFFERS_TO_FREE, 0);
	if (unlikely(buffers_to_free < -100))
        	return false;

//	if (*(struct sk_buff **)(fpa_head - sizeof(void *)) != skb)
//		return false;

	if (unlikely(skb->data < fpa_head))
		return false;

	if (unlikely(fpa_head - skb->head < sizeof(void *)))
		return false;

	if (unlikely((skb_end_pointer(skb) - fpa_head) < FPA_PACKET_POOL_SIZE))
		return false;

	if (unlikely(skb_shared(skb)) ||
	    unlikely(skb_cloned(skb)) ||
	    unlikely(skb->fclone != SKB_FCLONE_UNAVAILABLE))
		return false;

	if (unlikely((int)skb_shinfo(skb)->nr_frags != 0))
        	return false;

	if (skb_has_frag_list(skb)) {
	 	int frag_count = 0;
	 	struct sk_buff *skb_tmp;

		skb_walk_frags(skb, skb_tmp)
			frag_count++;

		if (unlikely(frag_count != 0)) {
        	return false;
		}
	}
	return true;
}

static inline void cvm_oct_skb_prepare_for_reuse(struct sk_buff *skb)
{
	struct skb_shared_info *shinfo;
	unsigned char *fpa_head = cvm_oct_get_fpa_head(skb);
	
	skb->data_len = 0;
	skb_frag_list_init(skb);

	/* The check also resets all the fields. */
	skb_release_head_state(skb);

	shinfo = skb_shinfo(skb);
	memset(shinfo, 0, offsetof(struct skb_shared_info, dataref));
	atomic_set(&shinfo->dataref, 1);
	
	memset(skb, 0, offsetof(struct sk_buff, tail));
	skb->data = skb->head + NET_SKB_PAD;
	skb_reset_tail_pointer(skb);

	*(struct sk_buff **)(fpa_head - sizeof(void *)) = skb;
	skb->truesize = sizeof(*skb) + skb_end_pointer(skb) - skb->head;
}

/*
 * TODO BUG: This function doesn't handle skb with multiple segments
 * i.e packets > 2048 bytes say
 */
static inline int xmit_fast(struct sk_buff *skb, int pko_ipoffp1)
{
	unsigned long flags;
	cvmx_buf_ptr_t                  hw_buffer;
	cvmx_pko_command_word0_t        pko_command;
	struct octeon_ethernet          *priv = netdev_priv(skb->dev);
	cvmx_pko_lock_t lock_type;
	int qos;

	if (!(skb->dev->flags & IFF_UP)) {
		netdev_err(skb->dev, "Error: Device not up\n");
		dev_kfree_skb_any(skb);
		return -1;
	}
	qos = skb->cvm_info.qos_level;

	if (priv->tx_lockless) {
		qos = cvmx_get_core_num();
		lock_type = CVMX_PKO_LOCK_NONE;
	} else {
		/*
		 ** The check on CVMX_PKO_QUEUES_PER_PORT_* is designed to
		 ** completely remove "qos" in the event neither interface
		 ** supports multiple queues per port
		 **/
		if (priv->tx_multiple_queues) {
			if (qos <= 0)
				qos = 0;
			else if (qos >= priv->num_tx_queues)
				qos = 0;
		} else
			qos = 0;
		lock_type = CVMX_PKO_LOCK_CMD_QUEUE;
	}
	
	/* Build the PKO buffer pointer */
	hw_buffer.u64 = 0;
	hw_buffer.s.addr = cvmx_ptr_to_phys(skb->data);
	hw_buffer.s.size = FPA_PACKET_POOL_SIZE; //skb->len; 
	cvm_oct_set_back(skb,&hw_buffer);

	/* Build the PKO command */
	pko_command.u64 = 0;
	pko_command.s.segs = 1;
	pko_command.s.total_bytes = skb->len;
	pko_command.s.ipoffp1 = sizeof(struct ethhdr) + 1 + pko_ipoffp1; 

	cvm_oct_skb_prepare_for_reuse(skb);

	local_irq_save(flags);

	cvmx_pko_send_packet_prepare_pkoid(priv->pko_port, priv->tx_queue[qos].queue, lock_type);

	if (unlikely(cvmx_hwpko_send_packet_finish_pkoid(priv->pko_port, priv->tx_queue[qos].queue, pko_command, hw_buffer, lock_type))){
		netdev_err(skb->dev, "Error: Failed to send the packet\n");
		dev_kfree_skb_any(skb);
	}

	local_irq_restore(flags);
	cvmx_hwfau_atomic_add32(FAU_NUM_PACKET_BUFFERS_TO_FREE, -1);

	return 0;
}

static inline void pkt_transmit_qos(
			struct net_device *dev, 
			cvmx_wqe_t *wqe,
			struct sk_buff *skb, 
			bool hw_free)
{
#if defined(CONFIG_OCTEON3_ETHERNET) || defined(CONFIG_OCTEON3_ETHERNET_MODULE)
	if (octeon_has_feature_OCTEON_FEATURE_PKO3()) {
		octeon3_transmit_qos(dev, wqe, hw_free, skb->cvm_info.qos_level);
		return;
	}
#endif

#if defined(CONFIG_OCTEON_ETHERNET) || defined(CONFIG_OCTEON_ETHERNET_MODULE)
	if (!hw_free)
		cvm_oct_transmit_qos_not_free(dev, (void *)wqe, skb);
	else
		cvm_oct_transmit_qos(dev, (void*)wqe, 1, skb->cvm_info.qos_level);
#endif
}

void platform_set_hw_ip_csum_compute(void  *work, bool flag)
{
	cvmx_wqe_t *wqe = NULL;
	if(octeon_has_feature(OCTEON_FEATURE_CN78XX_WQE)) {
		if (!flag) {
			/* 
			 *  For 78xx, we will say it is not IP to 
			 *  exclude it from CSUM. 
			 *  This applies to IPv6 as well
			 */
			cvmx_wqe_set_l3_ipv4(work, false);
		}
	} else {
		wqe = work;
		wqe->word2.s.IP_exc = !flag;
	}
}

/*
 * platform_copy_l2		Copies l2 data to reserved space 
 * 				above skb->data and adjusts skb->data 
 * 				to valid offset. 
 * 				Assumes enough reserve space is there.
 * 				This also adjusts wqe pointer appropriately
 * 				
 */
int platform_copy_l2(struct sk_buff *skb, cvmx_wqe_t *wqe, void *data, u16 len)
{
	cvmx_buf_ptr_t packet_ptr;
	cvmx_buf_ptr_pki_t packet_ptr_78xx;
	cvmx_wqe_78xx_t *wqe_78xx = NULL;

	if (skb_cow_head(skb, len))
		return -1;

	if (octeon_has_feature(OCTEON_FEATURE_CN78XX_WQE)) {

		wqe_78xx = (void *)wqe;

		if (wqe_78xx && (cvmx_wqe_get_bufs((void *)wqe_78xx) > 1))
			packet_ptr_78xx = *(cvmx_buf_ptr_pki_t *)phys_to_virt(wqe_78xx->packet_ptr.addr - 8);
		/*
		 * Copy L2 data
		 */
		skb->data = ((u8 *)skb->data - len);
		memcpy(skb->data, data, len);
		skb->len += len;
		
		/* set the WQE fields */
		if (wqe_78xx) {
			wqe_78xx->packet_ptr.addr = cvmx_ptr_to_phys(skb->data);
			wqe_78xx->packet_ptr.size = skb_headlen(skb);
			/* put next buffer pointer */
			if (cvmx_wqe_get_bufs((void *)wqe_78xx) > 1)
				*((cvmx_buf_ptr_pki_t *)phys_to_virt(wqe_78xx->packet_ptr.addr - 8)) = packet_ptr_78xx;
			else
				platform_set_hw_ip_csum_compute(wqe_78xx, true);
		}
	} else {
		if (wqe && (cvmx_wqe_get_bufs(wqe) > 1))
			packet_ptr = *(cvmx_buf_ptr_t *)phys_to_virt(wqe->packet_ptr.s.addr - 8);

		skb->data = ((u8 *)skb->data - len);
		memcpy(skb->data, data, len);
		skb->len += len;
		/* set the WQE fields */
		if (wqe) {
			wqe->packet_ptr.s.addr = cvmx_ptr_to_phys(skb->data);
			wqe->packet_ptr.s.size = skb_headlen(skb);
			/* put next buffer pointer */
			if (wqe->word2.s.bufs > 1)
				*((cvmx_buf_ptr_t *)phys_to_virt(wqe->packet_ptr.s.addr - 8)) = packet_ptr;
			else
				platform_set_hw_ip_csum_compute(wqe, true);
		}

	}

	return 0;
}

int platform_skb_xmit(struct sk_buff *skb, 
									cvmx_wqe_t *wqe, 
									u8	oct_odev,
									int	ip_offset,
									int is_ipv6) {

	int ret = CVM_IPFWD_RET_SUCCESS_FAST;

	skb_set_network_header(skb, ip_offset);
	if (!oct_odev) {
		dev_queue_xmit(skb);
		ret = CVM_IPFWD_RET_SUCCESS_SLOW;
	} else {
		if (wqe) {
			platform_set_hw_ip_csum_compute(wqe, (is_ipv6) ? false : true);

			cvmx_wqe_set_unused8(wqe, (ip_offset - ETH_HLEN));
			cvmx_wqe_set_len(wqe, skb->len);

			if (cvmx_wqe_get_bufs(wqe) > 1) {
				pkt_transmit_qos(skb->dev, (void *)wqe, skb, false);
				ret = CVM_IPFWD_RET_SUCCESS_SLOW;
			} else {
				cvmx_wqe_set_l3_ipv4(wqe, !is_ipv6);

				skb->pkt_type = PACKET_HOST; /* For skb resue */
				pkt_transmit_qos(skb->dev, (void*)wqe, skb, true);
			}
		} else {
			dev_queue_xmit(skb);
			ret = CVM_IPFWD_RET_SUCCESS_SLOW;
		}
	}

	return ret;
}

