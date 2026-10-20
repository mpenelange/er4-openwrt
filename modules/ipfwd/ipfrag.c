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

#ifdef CVM_IPFWD_FRAG_SUPPORT

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/types.h>
#include <linux/spinlock.h>
#include <linux/skbuff.h>
#include <linux/netfilter.h>
#include <linux/netfilter_ipv4.h>
#include <linux/udp.h>
#include <linux/tcp.h>
#include <linux/ip.h>
#include <linux/vmalloc.h>
#include <linux/seq_file.h>
#include <linux/proc_fs.h>
#include <linux/mii.h>

#include <net/ip.h>

#include "ipfwd.h"
#include "ipfrag.h"
#include "ipfwd_proc.h"

extern uint8_t cvm_gbl_ipfwd_cache_flush_stamp;
extern int cvm_ipfwd_get_free_entry(cvm_ipfwd_flow_bucket_t *bucket, cvm_ipfwd_flow_entry_t **entry);
extern int cvm_ipfwd_check_bucket_timestamp(cvm_ipfwd_flow_bucket_t *bucket);
extern cvm_ipfwd_flow_bucket_t *cvm_gbl_ipv4_fwd_cache;
#ifdef CVM_IPFWD_DEBUG
extern uint64_t cvm_ipfwd_count;
#endif


/**
 * Function to randomly return TRUE/FALSE.
 */
static inline int cvm_ipfwd_random_select(void)
{
    return (((cvmx_get_cycle() >> CVM_IPFWD_RND_SHIFT) & CVM_IPFWD_RND_MSK) == CVM_IPFWD_RND_VAL);
}

/**
 * Helper function to check the timestamp.
 *
 * @param created timestamp to check
 *
 * @return 
 *    CVM_IPFWD_EXPIRED - timestamp is expired
 *    CVM_IPFWD_OLD     - timestamp is old (=not new and close to expiration)
 *    CVM_IPFWD_NEW     - timestamp is new
 */
static inline int cvm_ipfwd_check_timestamp(uint64_t created, uint8_t cache_flush_stamp)
{
    uint64_t now;

    now = CVM_IPFWD_TIMER_GET_TIME;

    if ((now < created) || (cache_flush_stamp != cvm_gbl_ipfwd_cache_flush_stamp))
        return CVM_IPFWD_EXPIRED;    /* Wrap around -- treat as expired */

    if (now < (created + CVM_IPFWD_TIMER_NEW_LIFETIME))
        return CVM_IPFWD_NEW;    

    if (now < (created + CVM_IPFWD_TIMER_TOTAL_LIFETIME))
        return CVM_IPFWD_OLD;

    return CVM_IPFWD_EXPIRED;
}

static inline int cvm_ipfwd_frag_find_entry(cvm_ipfwd_flow_bucket_t *bucket,  /* ptr to hash bucket (input) */
        struct iphdr* ip,                 /* ptr to IP header (input) */
        cvm_ipfwd_flow_entry_t *entry)    /* ptr to flow entry (output) */
{
    uint32_t saddr = ip->saddr, daddr = ip->daddr;
    uint16_t frag_id = ip->id;
    int count, idx;
    uint8_t  proto = ip->protocol;

    for (idx = 0; idx < CVM_IPFWD_ENTRIES_PER_BUCKET; idx++)
    {
        count = CVM_IPFWD_ENTRY_RETRIES;

        /* Read current entry */
        do {
            *entry = bucket->entry[idx];
        } while ((--count >= 0) && (entry->s.id0 != entry->s.id2));

        if (count >= 0)
        {
            /* Test current entry -- compare 5-tuple */
            if ((saddr != entry->s.ip_saddr) || (daddr != entry->s.ip_daddr) ||
                    (proto != entry->s.ip_proto) ||
                    (frag_id != (entry->s.l4_sport)))
                continue;

            /* Found */
            /* Prefetch flow info 
               if (entry->s.flow_info)
               CVMX_PREFETCH0(phys_to_virt(entry->s.flow_info << 2);
               prefetch defered for now
             */
            //printk("found (idx = %d)\n", idx);
            return idx;
        }
    }

    /* If we get here, entry was not found */
    //printk("not found\n");
    return CVM_IPFWD_NOT_FOUND;
}

/**
 * Slow-path: Check bucket timestamp.
 *
 * @param *bucket ptr to hash bucket
 *
 */
static void cvm_ipfwd_frag_mark_packet(struct sk_buff *skb, cvm_ipfwd_flow_bucket_t *bucket)
{
    struct iphdr *ip = (struct iphdr*) (skb->data);
    //dump_packet(skb->data, skb->len);

    skb->cvm_info.frag_bucket = (void *)bucket;
    skb->cvm_info.cookie = skb->protocol;
    skb->cvm_info.cvmip.saddr = ip->saddr;
    skb->cvm_info.cvmip.daddr = ip->daddr;
    skb->cvm_info.cvmip.protocol = ip->protocol;
    skb->cvm_info.cvmip.tot_len = ip->tot_len;
    skb->cvm_info.cvmip.ihl = ip->ihl;
    skb->cvm_info.cvmip.id = ip->id;

}

/**
 * Format flow entry fields, based on an IP packet.
 *
 * Note! Bucket must be locked prior to calling this function 
 *
 * @param *ip pointer to an IP header
 * @param *entry pointer to a flow entry
 * @return none
 */
static void cvm_ipfwd_frag_setup_entry(struct iphdr *ip, cvm_ipfwd_flow_entry_t *entry)
{
    uint8_t id = entry->s.id0 + 1;  /* Cache current id count */

    /* Free flow_info buf if one exists */
    if (entry->s.flow_info) {
        kfree((void *)phys_to_virt(entry->s.flow_info << 2));
        entry->s.flow_info = 0;
    }

    /* Clear entry */
    entry->u.word0 = 0;
    entry->u.word1 = 0;
    entry->u.word2 = 0;

    entry->s.id0 = id;
    entry->s.id1 = id;
    entry->s.id2 = id;
    entry->s.ip_proto = ip->protocol;
    entry->s.ip_saddr = ip->saddr;
    entry->s.ip_daddr = ip->daddr;
    entry->s.l4_sport = ip->id;
    entry->s.l4_dport = 0xDEAD;

    entry->s.cache_flush_stamp = cvm_gbl_ipfwd_cache_flush_stamp;
}

/**
 * Copy flow info structure.  Copies Ethernet dst/src, IP src/dst/proto,
 * and L4 ports from a packet pointed to by the skb into the flow info
 * structure.
 *
 * @param *info pointer to flow info structure
 * @param *skb  pointer to sk_buff
 * @param *dev  pointer to output device structure
 * @return none
 */
static void cvm_ipfwd_frag_copy_flow_info(cvm_ipfwd_flow_info_t *dst, cvm_ipfwd_flow_info_t *orig)
{
    int hh_alen;

    dst->l2_len = orig->l2_len;
    hh_alen = HH_DATA_ALIGN(orig->l2_len);
    memcpy(((uint8_t *)dst->l2_hdr) + 32 - hh_alen,
           ((uint8_t *)orig->l2_hdr) + 32 - hh_alen,
           hh_alen);

    dst->ip_saddr = orig->ip_saddr;
    dst->ip_daddr = orig->ip_daddr;
    dst->ip_proto = orig->ip_proto;
    dst->dev = orig->dev;
    dst->oct_odev = orig->oct_odev;
    dst->ip_tos = orig->ip_tos;

#ifdef CVM_QOS_POLICER
    dst->nfmark = orig->nfmark; 
#endif
}

/**
 * Helper function to check if the timestamp was just created 
 *
 * @param created timestamp to check
 *
 * @return 1: true -- 0: false
 *
 */
static inline int cvm_ipfwd_check_timestamp_just_created(const uint64_t created)
{
	const uint64_t now = CVM_IPFWD_TIMER_GET_TIME;

	if (likely(created <= now)) {
		if (now - created < HZ) {
			return 1;
		}
	} else {
		if (CMV_IPFWD_TIMER_MAX - created + now < HZ) {
			return 1;
		}
	}

	return 0;
}

/**
 * Cache flow routine.
 *
 * If packet info (at the end of the packet buffer) is valid, a new
 * flow entry (and flow info) will be created for the packet.
 *
 * The following must be true for the flow to be cached:
 *    - packet_info->cookie must be valid
 *    - packet_info->bucket must be valid (LUT bucket ptr)
 *    - packet length must not have changed during its traversal
 *      through the Linux stack
 *    - If TCP, sequence number and sequence acknowlegement numbers
 *      must not have changed
 *
 * If any of the above conditions is not true, then the flow associated with
 * this packet will not be cached.
 *
 * @param *skb pointer to sk_buff
 * @param *dev pointer to output interface's device structe
 */
int cvm_ipfwd_frag_cache_firstfrag(struct sk_buff *skb, struct iphdr *ip_first, cvm_ipfwd_flow_info_t *info)
{
    int idx, status;
    cvm_ipfwd_flow_entry_t *entry;
    cvm_ipfwd_flow_bucket_t *bucket;
    cvm_ipfwd_flow_info_t *iptr;

    idx = platform_get_hash_frag_bucket(ip_first); 

    bucket = &cvm_gbl_ipv4_fwd_cache[idx];
    spin_lock(&bucket->hdr.wr_lock);
    idx = cvm_ipfwd_frag_find_entry(bucket, ip_first, &entry);

    if(idx== CVM_IPFWD_NOT_FOUND){
        idx = cvm_ipfwd_get_free_entry(bucket, &entry); /* Find available entry (replace oldest) */
        /* If the entry-to-be-replaced was just created, don't replace it */
        if ((entry->s.l4_dport != 0xDEAD) && (cvm_ipfwd_check_timestamp_just_created(entry->s.timestamp))) {
            spin_unlock(&bucket->hdr.wr_lock);
            return 0;
        }
        cvm_ipfwd_frag_setup_entry(ip_first, entry);     /* Set entry fields -- free 
                                                * flow info ptr if one exists */
    } else {
        status = cvm_ipfwd_check_timestamp(entry->s.timestamp, entry->s.cache_flush_stamp);
        if (status == CVM_IPFWD_NEW)
            goto done;

        /* OLD & EXPIRED => setup new flow info (at least for now -- add
         * conditional update later, if necessary) */
        if (entry->s.flow_info) {
             kfree((void *)phys_to_virt(entry->s.flow_info << 2));
            entry->s.flow_info = 0;
        }
    }

    /* See if need to allocate info buffer */
    if (!entry->s.flow_info) {
        iptr = kmalloc(sizeof(cvm_ipfwd_flow_info_t),GFP_ATOMIC);

        if (iptr == NULL)
        {
            //DEBUGPRINT("%s: Failed to allocate flow info buffer\n", __func__); 
            spin_unlock(&bucket->hdr.wr_lock);
            return (0);
        }

        entry->s.flow_info = virt_to_phys(iptr) >> 2;
        /* Setup info */
        cvm_ipfwd_frag_copy_flow_info(iptr, info);
        iptr->ports = ip_first->id;
    } else
        iptr = phys_to_virt(entry->s.flow_info << 2);

    /* Refresh time stamp */
    entry->s.timestamp = CVM_IPFWD_TIMER_GET_TIME;

    /* Update the cache_flush_stamp value */
    entry->s.cache_flush_stamp = cvm_gbl_ipfwd_cache_flush_stamp;

    /* No need to store entry, entry table is static array*/
    //bucket->entry[idx] = entry;

done:
    spin_unlock(&bucket->hdr.wr_lock);
    return (0);
}
/**
 * Setup flow info structure.  Copies Ethernet dst/src, IP src/dst/proto,
 * and L4 ports from a packet pointed to by the skb into the flow info
 * structure.
 *
 * @param *info pointer to flow info structure
 * @param *skb  pointer to sk_buff
 * @param *dev  pointer to output device structure
 * @return none
 */
static void cvm_ipfwd_frag_setup_flow_info(cvm_ipfwd_flow_info_t *info, struct sk_buff *skb, struct net_device *dev)
{
    int idx;
    struct iphdr *ip;

/*
 * skb->dst does not contain hh field in 3.10 or 4.4 kernel
 * This is probably written for pre 3.10 kernel
 * It should be reevaluated
 */
#if 0
    int hh_alen;
    struct hh_cache *hh;
    struct dst_entry *dst = skb_dst(skb); 
    /* Cache L2 header (skb->dst and skb->dst->hh already checked for null ptrs
     * earlier) */
    hh = dst->hh;
    write_seqlock(&hh->hh_lock);
    info->l2_len = hh->hh_len;
    if (info->l2_len > 32)
        info->l2_len = 32;
    hh_alen = HH_DATA_ALIGN(info->l2_len);
    memcpy(((uint8_t *)info->l2_hdr)+32-hh_alen, hh->hh_data, hh_alen);
    write_sequnlock(&hh->hh_lock);
#endif

    ip = (struct iphdr *)skb_network_header(skb);
    info->ip_saddr = ip->saddr;
    info->ip_daddr = ip->daddr;
    info->ip_proto = ip->protocol;
    info->ports = ip->id;
    info->dev = dev;
    info->oct_odev = dev->is_cvm_dev;
    info->ip_tos = ip->tos;

#ifdef CVM_QOS_POLICER
    info->nfmark = skb->mark & 0x7;
#endif
#ifdef CVM_IPFWD_DEBUG 
#if 0    
    info->stats_pkt_recv = 0;
    info->stats_pkt_send = 0;
#endif    
#endif /* CVM_IPFWD_DEBUG */
}

/**
 * Cache flow routine.
 *
 * If packet info (at the end of the packet buffer) is valid, a new
 * flow entry (and flow info) will be created for the packet.
 *
 * The following must be true for the flow to be cached:
 *    - packet_info->cookie must be valid
 *    - packet_info->bucket must be valid (LUT bucket ptr)
 *    - packet length must not have changed during its traversal
 *      through the Linux stack
 *    - If TCP, sequence number and sequence acknowlegement numbers
 *      must not have changed
 *
 * If any of the above conditions is not true, then the flow associated with
 * this packet will not be cached.
 *
 * @param *skb pointer to sk_buff
 * @param *dev pointer to output interface's device structe
 */
int cvm_ipfwd_frag_cache_flow(struct sk_buff *skb, struct cvm_packet_info *info)
{
    int idx, status;
    cvm_ipfwd_flow_entry_t entry;
    cvm_ipfwd_flow_bucket_t *bucket;
    cvm_ipfwd_flow_info_t *iptr;
    /* iph points to the new header -- ip points to the cached header */
    struct iphdr *ipnew = (struct iphdr *)skb_network_header(skb), *ip = (struct iphdr *)&info->cvmip;
    /* Check whether this buffer has valid packet_info */
    if (info->frag_bucket == NULL) {
        return 0;
    }
    bucket = info->frag_bucket;

    /* Verify length */
    if (ip->tot_len != ipnew->tot_len) {
        return 0;
    }

    /* packet_info valid -> lock bucket */
    spin_lock(&bucket->hdr.wr_lock);

    /* See if a matching entry already exists */
    idx = cvm_ipfwd_frag_find_entry(bucket, ip, &entry);

    if (idx == CVM_IPFWD_NOT_FOUND)
    {
        idx = cvm_ipfwd_get_free_entry(bucket, &entry); /* Find available entry (replace oldest) */

        /* If the entry-to-be-replaced was just created, don't replace it */
        if (cvm_ipfwd_check_timestamp_just_created(entry.s.timestamp)) {
            spin_unlock(&bucket->hdr.wr_lock);
            return 0;
        }

        cvm_ipfwd_frag_setup_entry(ip, &entry);     /* Set entry fields -- free
                                                * flow info ptr if one exists */
    } else {
        status = cvm_ipfwd_check_timestamp(entry.s.timestamp, entry.s.cache_flush_stamp);
        if (status == CVM_IPFWD_NEW)
            goto done;

        /* OLD & EXPIRED => setup new flow info (at least for now -- add
         * conditional update later, if necessary) */
        if (entry.s.flow_info) {
             kfree((void *)phys_to_virt(entry.s.flow_info << 2));
            entry.s.flow_info = 0;
        }
    }

    /* See if need to allocate info buffer */
    if (!entry.s.flow_info) {
        iptr = kmalloc(sizeof(cvm_ipfwd_flow_info_t),GFP_ATOMIC);

        if (iptr == NULL)
        {
            //DEBUGPRINT("%s: Failed to allocate flow info buffer\n", __func__); 
            spin_unlock(&bucket->hdr.wr_lock);
            return (0);
        }

        entry.s.flow_info = virt_to_phys(iptr) >> 2;
        /* Setup info */
        cvm_ipfwd_frag_setup_flow_info(iptr, skb, skb->dev);
    } else
        iptr = phys_to_virt(entry.s.flow_info << 2);

#ifdef CVM_IPFWD_DEBUG
#if 0        
    iptr->stats_pkt_recv++;
    iptr->stats_pkt_send++;
#endif    
#endif /* CVM_IPFWD_DEBUG */


    /* Refresh time stamp */
    entry.s.timestamp = CVM_IPFWD_TIMER_GET_TIME;

    /* Update the cache_flush_stamp value */
    entry.s.cache_flush_stamp = cvm_gbl_ipfwd_cache_flush_stamp;

    /* Store entry */
    bucket->entry[idx] = entry;

done:
    spin_unlock(&bucket->hdr.wr_lock);
    return (0);
}

/**
 * Helper function to calculate IPv4 header checksum.
 * 
 * @param *ip pointer to the beginning of IP header
 * 
 * @return 16-bit one's complement IPv4 checksum.
 * No alignment requirements.
 */
static inline uint16_t cvm_ipfwd_calculate_ip_header_checksum(uint16_t *ip)
{
    uint64_t sum;
    uint16_t *ptr = ip;
    uint8_t *bptr = (uint8_t*) ip;

    sum  = ptr[0];
    sum += ptr[1];
    sum += ptr[2];
    sum += ptr[3];
    sum += ptr[4];
    // Skip checksum field
    sum += ptr[6];
    sum += ptr[7];
    sum += ptr[8];
    sum += ptr[9];

    // Check for options
    if (cvmx_unlikely(bptr[0] != 0x45)) goto slow_cksum_calc;

return_from_slow_cksum_calc:

    sum = (uint16_t) sum + (sum >> 16);
    sum = (uint16_t) sum + (sum >> 16);
    return ((uint16_t) (sum ^ 0xffff));

slow_cksum_calc:
    // Add IPv4 options into the checksum (if present)
    {
        uint64_t len = (bptr[0] & 0xf) - 5;
        ptr = &ptr[len<<1];

        while (len-- > 0) {
            sum += *ptr++;
            sum += *ptr++;
        }
    }

    goto return_from_slow_cksum_calc;
}

u32 ipv4_frag_pkt_rcv(struct sk_buff *skb, cvmx_wqe_t *wqe, struct cvm_packet_info *info)
{
    cvm_ipfwd_flow_entry_t entry;
    cvm_ipfwd_flow_bucket_t *bucket = NULL;
    struct iphdr *ip;
    int idx, status;
    int skip_fastpath=0;
    cvm_ipfwd_flow_info_t *flow_info;
    int ret = CVM_IPFWD_RET_FAILED;

    ip = (struct iphdr *)skb->data;

    idx = platform_get_hash_frag_bucket(ip); 

    bucket = &cvm_gbl_ipv4_fwd_cache[idx];

    if(!skip_fastpath)
    {
        idx = cvm_ipfwd_frag_find_entry(bucket, ip, &entry);

        if(idx== CVM_IPFWD_NOT_FOUND){
            goto not_found;
        }

        /* Match found */
        /* check its time stamp */
        status = cvm_ipfwd_check_timestamp(entry.s.timestamp, entry.s.cache_flush_stamp);

        if(status == CVM_IPFWD_EXPIRED){
            goto not_found;
        }
        if ((status != CVM_IPFWD_NEW) && (cvm_ipfwd_random_select()))
        {
            /* Old match found and this packet was selected to go through
             * the Linux stack.  Make sure there is not already someone
             * in this bucket doing this. */
            if (cvm_ipfwd_check_bucket_timestamp(bucket)){
                goto not_found;
            }
        }

        /* If we get here, entry is not expired */
        if (entry.s.flow_info)
        {
            int hh_alen; 

            /* match found -- format header */
            flow_info = phys_to_virt(entry.s.flow_info << 2);
            prefetch(flow_info);
            prefetchw(skb);

#ifdef CVM_QOS_POLICER
            /* QoS - Policing / Rate limiting */
            skb->mark   = flow_info->nfmark;

            /* 
             * Send the packet out if
             * - policing / rate limiting is OFF  or
             * - packet is rate conformant 
             */
            if ((cvm_qos_policer[flow_info->nfmark].is_policer_on == 0) ||
                (cvm_qos_rate_limit(skb->len + CVM_QOS_POLICER_ETHERNET_HEADER_LEN, flow_info->nfmark) == 1))
            {
                goto transmit_pkt;
            }
            else
            {
                /* Packet is NOT rate conformant. DROP the packet. */
                if (wqe && flow_info->oct_odev)
                {
                    platform_free_work(wqe);
                    // kfree_skb(skb);   // ???
                    return CVM_IPFWD_RET_SUCCESS_FAST;
                }
                else
                {
                    dev_kfree_skb_any(skb);
                    return CVM_IPFWD_RET_SUCCESS_SLOW;
                }
            }

transmit_pkt:
#endif /* CVM_QOS_POLICER */

            hh_alen = HH_DATA_ALIGN(flow_info->l2_len);
            memcpy(skb->data-hh_alen, ((uint8_t *)flow_info->l2_hdr)+32-hh_alen, hh_alen);

            ip = (struct iphdr*) skb->data;
            if (ip->ttl < 2)
            {
                return CVM_IPFWD_RET_FAILED;
            }
            ip->ttl--;
            ip->saddr = flow_info->ip_saddr;
            ip->daddr = flow_info->ip_daddr;
            ip->protocol = flow_info->ip_proto;
            // ip->tos = flow_info->ip_tos;

            /* compute IP checksum */
            ip->check = cvm_ipfwd_calculate_ip_header_checksum((uint16_t*) ip);

            ret = platform_skb_xmit(skb, wqe, flow_info->oct_odev, flow_info->ip_offset, 0);

            update_ipfwd_stats(skb->protocol, skb->protocol, ret, skb->len, skb->len);

            /* done */
            return ret;
        }

not_found:
        cvm_ipfwd_frag_mark_packet(skb, bucket);
#ifdef CVM_QOS_POLICER
        skb->mark = 0; /* reset nfmark before sending the packet to the stack */
#endif

    }
    return CVM_IPFWD_RET_FAILED;
}

#endif
