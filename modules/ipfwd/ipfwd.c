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

#include <linux/inetdevice.h>
#include <linux/workqueue.h>
#include <linux/mutex.h>
#include <net/addrconf.h>
#include <net/fib_notifier.h>
#include <net/netevent.h>
#include <net/neighbour.h>
#include <linux/jhash.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/types.h>
#include <linux/spinlock.h>
#include <linux/skbuff.h>
#include <linux/netfilter.h>
#include <linux/if.h>
#include <linux/if_pppox.h>
#include <linux/ppp_defs.h>
#include <linux/if_vlan.h>
#include <linux/netfilter_ipv4.h>
#include <linux/udp.h>
#include <linux/tcp.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/vmalloc.h>
#include <linux/seq_file.h>
#include <linux/proc_fs.h>
#include <linux/mii.h>
#include <linux/netdevice.h>
#include <linux/poison.h>
#include <uapi/linux/if.h>
#include <net/ip.h>

#include "ipfwd_compat.h"
#include "ipfwd_common.h"
 
#include "ipfwd_proc.h"
#include "ipfwd_input_qos.h"
#include "ipfwd_output_qos.h"
#include "ipfwd_filter.h"

#include "ipfwd.h"
#ifdef CVM_IPFWD_FRAG_SUPPORT
#include "ipfrag.h"
#endif

#ifdef FLOW_COUNTERS
#include "export.h"
#endif

static const char ipfwd_string[] = "Cavium IP forwarding Module";

#define IPFWD_VERSION	__stringify(MAJOR_NUMBER) "." __stringify(MINOR_NUMBER)
static const char ipfwd_version[] = IPFWD_VERSION;

static bool cvm_ipv4_fwd __read_mostly = true;
module_param_named(ipv4, cvm_ipv4_fwd, bool, 0644);
MODULE_PARM_DESC(ipv4, "Enable IPv4 Forwarding");

unsigned int ipv4_cache_size __read_mostly = CVM_IPFWD_LUT_DEFAULT;
module_param(ipv4_cache_size, int, 0);
MODULE_PARM_DESC(ipv4_cache_size, "Set IPv4 cache size (Must be power of 2). Max:32768. Default: 8192.");

static bool cvm_ipv4_pppoe __read_mostly = false;
#ifdef IPFWD_IPV4_PPPOE
module_param_named(ipv4_pppoe, cvm_ipv4_pppoe, bool, 0644);
MODULE_PARM_DESC(ipv4_pppoe, "Enable PPPoE IPv4 Forwarding");
#endif

static bool cvm_ipv4_vlan __read_mostly = false;
module_param_named(ipv4_vlan, cvm_ipv4_vlan, bool, 0644);
MODULE_PARM_DESC(ipv4_vlan, "Enable VLAN IPv4 Forwarding");

static bool cvm_ipv4_gre __read_mostly = false;
module_param_named(ipv4_gre, cvm_ipv4_gre, bool, 0644);
MODULE_PARM_DESC(ipv4_gre, "Enable IPv4 GRE tunnel Forwarding");

static bool cvm_ipv4_bonding __read_mostly = false;
#ifdef IPFWD_IPV4_BONDING
module_param_named(ipv4_bonding, cvm_ipv4_bonding, bool, 0644);
MODULE_PARM_DESC(ipv4_bonding, "Enable IPv4 bonding Forwarding");
#endif

bool cvm_ipv6_fwd __read_mostly = false;
module_param_named(ipv6, cvm_ipv6_fwd, bool, 0644);
MODULE_PARM_DESC(ipv6, "Enable IPv6 Forwarding");

int ipv6_cache_size __read_mostly = CVM_IPV6FWD_LUT_DEFAULT;
module_param(ipv6_cache_size, int, 0);
MODULE_PARM_DESC(ipv6_cache_size, "Set IPv6 cache size (Must be power of 2). Max:32768. Default: 8192.");

bool cvm_ipv6_pppoe __read_mostly = false;
#ifdef IPFWD_IPV6_PPPOE 
module_param_named(ipv6_pppoe, cvm_ipv6_pppoe, bool, 0644);
MODULE_PARM_DESC(ipv6_pppoe, "Enable PPPoE IPv6 Forwarding");
#endif

bool cvm_ipv6_vlan __read_mostly = false;
module_param_named(ipv6_vlan, cvm_ipv6_vlan, bool, 0644);
MODULE_PARM_DESC(ipv6_vlan, "Enable VLAN IPv6 Forwarding");

bool cvm_ipv6_bonding __read_mostly = false;
#ifdef IPFWD_IPV6_BONDING
module_param_named(ipv6_bonding, cvm_ipv6_bonding, bool, 0644);
MODULE_PARM_DESC(ipv6_bonding, "Enable IPv6 Bonding Forwarding");
#endif
#ifdef FLOW_COUNTERS
bool cvm_ipv4_export __read_mostly = false;
module_param_named(ipv4_export, cvm_ipv4_export, bool, 0644);
MODULE_PARM_DESC(ipv4_export, "Enable IPv4 export");
#endif
#ifdef DPI
static bool cvm_ipv4_dpi __read_mostly = false;
module_param_named(ipv4_dpi, cvm_ipv4_dpi, bool, 0644);
MODULE_PARM_DESC(ipv4_dpi, "Enable IPv4 DPI");
#endif

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Cavium IP Forwarding Module\n");
MODULE_VERSION(IPFWD_VERSION);


/**
 * =============================================
 * = Cavium QoS support
 * =============================================
 */

#ifdef CVM_QOS_POLICER

cvm_qos_policer_t  cvm_qos_policer[CVM_QOS_NUM_POLICERS_MAX];
uint64_t           cvm_qos_tb_rate_const_scaled = 0;


static inline int  cvm_qos_policer_set (int pol_num, uint8_t is_policer_on, uint64_t rate_in_kbps, uint64_t depth_in_bytes, int32_t bytes_offset);
static inline int  cvm_qos_policer_init(void);
static inline int  cvm_qos_policer_deinit(void);
static        int  cvm_qos_stats_open(struct inode *inode, struct file *file);
static        int  cvm_qos_stats_show(struct seq_file *file, void *ptr);

static struct ipfwd_proc_ops cvm_qos_stats_operations = {
    IPFWD_PROC_OWNER
    IPFWD_PROC_OPEN    = cvm_qos_stats_open,
    IPFWD_PROC_READ    = seq_read,
    IPFWD_PROC_LSEEK  = seq_lseek,
    IPFWD_PROC_RELEASE = single_release,
};


/*
 * QoS - Module parameters:
 * These are located in /sys/module/cavium_ip_offload/parameters
 */

int qos_policer              = 0xFFFF;
int qos_policer_on           = 0;
int qos_policer_rate_in_kbps = 1000;
int qos_policer_burst_size_in_bytes = CVM_QOS_TB_DEPTH;
int qos_policer_bytes_offset = 0;
int qos_stats_clear          = 0;
int qos_stats_cache_flush    = 1;


module_param(qos_policer,              int, 0644);
module_param(qos_policer_on,           int, 0644);
module_param(qos_policer_rate_in_kbps, int, 0644);
module_param(qos_policer_burst_size_in_bytes, int, 0644);
module_param(qos_policer_bytes_offset, int, 0644);
module_param(qos_stats_clear,          int, 0644);
module_param(qos_stats_cache_flush,    int, 0644);

#endif /* CVM_QOS_POLICER */

/* Cavium multiple queues support */
#ifdef CVM_IPFWD_MQUEUES_SUPPORT

#define CVM_IPFWD_CLIENT_NAME    "cvm_ipfwd_offload"

int cvm_mq_en = 0;
int cvm_mq_cid = -1;

/* Intialize the client for mqueues support */

static inline int cvm_ipfwd_mq_init(void)
{

	cvm_mq_cid = platform_mq_register(CVM_IPFWD_CLIENT_NAME);

	if (cvm_mq_cid == -1)
	{
		pr_err("Cannot register to cvm_mq module\n");
		cvm_mq_en = 0;
		return cvm_mq_cid;
    	}
    
    	// cvm_mq_en = 1;
    
    	return cvm_mq_cid;
}

static inline void cvm_ipfwd_mq_exit(void)
{
	if (cvm_mq_cid != -1)
		platform_mq_unregister(cvm_mq_cid);
}

#endif /* CVM_IPFWD_MQUEUES_SUPPORT */

/*
 * Serializes control-plane users of the flow tables: anything that frees,
 * replaces or resizes a table (enable/disable, cache_size, flush, stamp-wrap
 * wipe, module exit) and anything that walks one from process context (/proc
 * cache dumps, per-entry clear, flow export). The fast path doesn't take it;
 * it is kept off a table by clearing the ipfwd_flags bit plus synchronize_net().
 */
DEFINE_MUTEX(cvm_ipfwd_table_mutex);

/** IPv4 fwd cache */
cvm_ipfwd_flow_bucket_t *cvm_gbl_ipv4_fwd_cache = NULL;
static int cvm_ipv4_ignore_cache_flush = 0;
/** IPv6 fwd cache */
static cvm_ipfwd_flow_bucket_t *cvm_gbl_ipv6_fwd_cache = NULL;
static int cvm_ipv6_ignore_cache_flush = 0;

/* Control counter for flushing the cache */
uint8_t cvm_gbl_ipfwd_cache_flush_stamp = 0;

/*
 * Free a flow_info buffer. The rx fast path uses flow_info without taking the
 * bucket lock, so it may still be reading a buffer that the learn path just
 * replaced on another core: free only after an RCU grace period. The rx
 * hook runs in NAPI softirq, an RCU read-side section.
 *
 * Test builds (make IPFWD_POISON=1) overwrite the buffer with POISON_FREE
 * when it is finally freed, so any use after the grace period shows up.
 */
#ifdef IPFWD_DEBUG_POISON
static void cvm_ipfwd_free_flow_info_rcu(struct rcu_head *head)
{
	cvm_ipfwd_flow_info_t *flow_info = container_of(head, cvm_ipfwd_flow_info_t, rcu);

	memset(flow_info, POISON_FREE, sizeof(*flow_info));
	kfree(flow_info);
}
#endif

static inline void cvm_ipfwd_free_flow_info(void *ptr)
{
	cvm_ipfwd_flow_info_t *flow_info = ptr;

#ifdef IPFWD_DEBUG_POISON
	call_rcu(&flow_info->rcu, cvm_ipfwd_free_flow_info_rcu);
#else
	kfree_rcu(flow_info, rcu);
#endif
}

/*
 * Flow entries are read locklessly by the rx fast path and written under the
 * bucket lock. id0/id1 form a sequence count: a writer sets id0 to a new
 * value, changes the entry, then sets id1 = id0; a reader copies the entry
 * between reading id1 and id0 and only trusts the copy if they match. Every
 * change a reader must see consistently (the key and flow_info) goes through
 * cvm_ipfwd_entry_write_begin()/_end(). Ids are 4 bits and never 0 once
 * written, so a never-used (all-zero) entry is never mistaken for a write in
 * progress.
 */
static inline void cvm_ipfwd_entry_write_begin(cvm_ipfwd_flow_entry_t *entry)
{
	u8 id = (entry->s.id1 + 1) & 0xf;

	entry->s.id0 = id ? id : 1;
	smp_wmb();
}

static inline void cvm_ipfwd_entry_write_end(cvm_ipfwd_flow_entry_t *entry)
{
	smp_wmb();
	entry->s.id1 = entry->s.id0;
}

static __always_inline void cvm_ipfwd_entry_ids(const cvm_ipfwd_flow_entry_t *entry, u8 *id0, u8 *id1)
{
	cvm_ipfwd_flow_entry_t t;

	t.u.word5 = READ_ONCE(entry->u.word5);
	*id0 = t.s.id0;
	*id1 = t.s.id1;
}

/* Clear everything but the ids (inside a write section) */
static inline void cvm_ipfwd_entry_clear(cvm_ipfwd_flow_entry_t *entry)
{
	entry->u.word0 = 0;
	entry->u.word1 = 0;
	entry->u.word2 = 0;
	entry->u.word3 = 0;
	entry->u.word4 = 0;
	entry->s.cache_flush_stamp = 0;
	entry->s.l4_dport = 0;
	entry->s.gre_key = 0;
	entry->u.word6 = 0;
}

static inline void cvm_ipfwd_flush_cache(cvm_ipfwd_flow_bucket_t* cache, int cache_size, int entries_per_bucket) {
	int i, j;
	cvm_ipfwd_flow_bucket_t *bucket;
	cvm_ipfwd_flow_entry_t *flow_entry;

	for (i = 0; i < cache_size; i++) {
		bucket = &cache[i];
		for (j = 0; j < entries_per_bucket; j++) {

			flow_entry = &bucket->entry[j];

			if(flow_entry->s.id0 && (flow_entry->s.id0 == flow_entry->s.id1)) {
				if (flow_entry->s.flow_info) {
					cvm_ipfwd_free_flow_info(phys_to_virt(flow_entry->s.flow_info << 2));
				}
			}

       		flow_entry->u.word0 = 0;
			flow_entry->u.word1 = 0;
			flow_entry->u.word2 = 0;
			flow_entry->u.word3 = 0;
			flow_entry->u.word4 = 0;
			flow_entry->u.word5 = 0;
			flow_entry->u.word6 = 0;
		}
	}
}
static int cvm_ipv6_fwd_cache_show(struct seq_file *file, void *ptr)
{
#if IPFWD_CACHE_SHOW
    cvm_ipfwd_flow_bucket_t *bucket     = NULL;
    cvm_ipfwd_flow_entry_t  *flow_entry = NULL;
    cvm_ipfwd_flow_info_t *flow_info = NULL;
    struct pppoe_hdr *ph = NULL;
    int sid = 0;
    uint64_t flow_ent_src[2] = {0};
    uint64_t flow_ent_dst[2] = {0};
    uint64_t flow_inf_src[2] = {0};
    uint64_t flow_inf_dst[2] = {0};


    int bb=0;
    int ee=0;

    seq_printf(file, "\n");
    seq_printf(file, "------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|\n");
    seq_printf(file, "Cavium ipv_fwd cache: (IPv6)\n");
    seq_printf(file, "================================================================================================================================================================================================|\n");
    seq_printf(file, "Buck| Entry| Bucket     | Src      | Src   | Dst      | Dst   | Proto | Timestamp  | PPPoE | VLAN |Cache |                            Flow Info                                                 |\n");
    seq_printf(file, " #  |      | Timestamp  | Addr     | Port  | Addr     | Port  |       |            | Sess  | Tag  |Flush |--------------------------------------------------------------------------------------|\n");
    seq_printf(file, "    |      |            |          |       |          |       |       |            |  ID   |      |      |L2 hlen| Src Addr | Dst Addr | Ports       | Proto | PPPOE | VLAN Tag | nfmark |\n");
    seq_printf(file, "================================================================================================================================================================================================|\n");

    mutex_lock(&cvm_ipfwd_table_mutex);
    if (!cvm_ipv6_fwd || !cvm_gbl_ipv6_fwd_cache) {
        mutex_unlock(&cvm_ipfwd_table_mutex);
        return 0;
    }

    rcu_read_lock();	/* flow_info may be freed concurrently (after a grace period) */
    for (bb = 0; bb < ipv6_cache_size; bb++)
    {
        bucket = &cvm_gbl_ipv6_fwd_cache[bb];
        if (bucket != NULL)
        {
            for (ee = 0; ee < CVM_IPFWD_ENTRIES_PER_BUCKET; ee++) 
            {
                flow_entry = &bucket->entry[ee];
                if (flow_entry != NULL) 
                {
   					if(!flow_entry->s.id0 || (flow_entry->s.id0 != flow_entry->s.id1))
						continue;

                    if (flow_entry->s.flow_info != 0)
                    {
                        flow_info = phys_to_virt(flow_entry->s.flow_info << 2);
                        if (flow_info != NULL)
                        {
				if (flow_info->l2_len > ETH_HLEN) {
					ph = (struct pppoe_hdr *)(flow_info->l2_hdr + ETH_HLEN);
					sid = ph->sid;	
				} else {
					sid = 0;
				}

				flow_ent_src[0] = flow_ent_src[1] = 0ULL;
				flow_ent_dst[0] = flow_ent_dst[1] = 0ULL;
				flow_inf_src[0] = flow_inf_src[1] = 0ULL;
				flow_inf_dst[0] = flow_inf_dst[1] = 0ULL;

				flow_ent_src[0] = flow_entry->s.ip_saddrhi;
				flow_ent_src[1] = flow_entry->s.ip_saddrlo;
				flow_ent_dst[0] = flow_entry->s.ip_daddrhi;
				flow_ent_dst[1] = flow_entry->s.ip_daddrlo;

				flow_inf_src[0] = flow_info->ip_saddrhi;
				flow_inf_src[1] = flow_info->ip_saddrlo;
				flow_inf_dst[0] = flow_info->ip_daddrhi;
				flow_inf_dst[1] = flow_info->ip_daddrlo;

			    seq_printf(file, "%4d| %5d| 0x%08x | %pI6c | %5u | %pI6c | %5u | %5u | 0x%08x | 0x%0x   |%5d |%5d | %5d | %pI6c | %pI6c | %5u %5u | %5u | 0x%0x   | %5u    | %6u |\n",
				bb,
				ee,
				bucket->hdr.timestamp,
				flow_ent_src,
				flow_entry->s.l4_sport,
				flow_ent_dst,
				flow_entry->s.l4_dport,
				flow_entry->s.ip_proto,
				flow_entry->s.timestamp,
				flow_entry->s.pppoe_sid,
				flow_entry->s.vlan_id,
				flow_entry->s.cache_flush_stamp,
				flow_info->l2_len,
				flow_inf_src,
				flow_inf_dst,
				ntohl(flow_info->ports) >> 16,
				ntohl(flow_info->ports) & 0xFFFF,	
				flow_info->ip_proto,
				sid,
				flow_info->vlan_tag,
#ifdef CVM_QOS_POLICER
                                flow_info->nfmark
#else
                                0
#endif
                                );
                        }
                    }
                }


            }
        }
    }
    rcu_read_unlock();
    mutex_unlock(&cvm_ipfwd_table_mutex);

    seq_printf(file, "------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|\n");
    seq_printf(file, "\n");
#endif

    return 0;
}

static int ipv6_fwd_cache_open(struct inode *inode, struct file *file)
{
    return single_open(file, cvm_ipv6_fwd_cache_show, NULL);
}

static ssize_t ipv6_fwd_cache_write(struct file *file, const char __user *buffer,
			            	size_t count, loff_t *ppos)
{
	char str[64], *strend;	/* input is a short number */
	int action;

	if(!cvm_ipv6_fwd) {
		printk(KERN_ERR"Ipv6 Ipfwd offload disabled.Please enable it and try again.!!!\n");
		return count;
	}


	if (count >= sizeof(str))
		return -EINVAL;

	if (copy_from_user(str, buffer, count))
		return -EFAULT;

	str[count] = '\0';

	action = simple_strtoul(str, &strend, 0);
	switch (action) {
	case 0:
		//printk("Flushing IPv4 flow cache: %s(%d)\n", current->comm, task_pid_nr(current));

		if (cvm_ipv6_ignore_cache_flush)
			break;

		mutex_lock(&cvm_ipfwd_table_mutex);
		if (!cvm_ipv6_fwd) {	/* disabled meanwhile */
			mutex_unlock(&cvm_ipfwd_table_mutex);
			break;
		}
		incr_ipfwd_flow_stat(IPV6_FLUSHES);
		cvm_ipv6_fwd = false;
		clear_ipv6_bit(ipfwd_flags);
		CVMX_SYNC;
		synchronize_net();	/* let fast-path readers finish before freeing */
		pr_info("\nFlushing IPv6 cache\n");
		cvm_ipfwd_flush_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
		cvm_ipv6_fwd = true;
		set_ipv6_bit(ipfwd_flags);
		CVMX_SYNCW;
		mutex_unlock(&cvm_ipfwd_table_mutex);
		break;
	default:
		pr_err("Unknown action\n");
		break;
	}

	return count;
}

#if IPFWD_CACHE_SHOW
static void print_flow_info(struct seq_file *file, int bkt_no, int ent_no, cvm_ipfwd_flow_entry_t *flow_entry, cvm_ipfwd_flow_info_t *flow_info)
{
	struct pppoe_hdr *ph = NULL;
	int pppoe_sid = 0;

	if (!flow_info)
		return;

	/* Leading machine-readable token so a test can map a flow to its bucket
	 * (the bucket-collision test reads this). The hash that picks the bucket is keyed
	 * per boot, so this placement is not predictable off-box. */
	seq_printf(file, "B%d/%d ", bkt_no, ent_no);

	if (test_pppoe_hdr(&flow_info->pkt_flags)) {
		if (test_vlan_hdr(&flow_info->pkt_flags))
			ph = (struct pppoe_hdr *)(flow_info->l2_hdr + ETH_HLEN + VLAN_HLEN);
		else
			ph = (struct pppoe_hdr *)(flow_info->l2_hdr + ETH_HLEN);
		pppoe_sid = ph->sid;	
	}

	seq_printf(file, "| %5s | %5s | %pI4 | %5u | %pI4 | %5u | %5u |   %u  |   %u  |  %pI4   | %5u  | %pI4   | %5u   | %5u | %u | %u | %u | %u | %lu    | %lu   | %d | %d | %d\n",
			flow_info->cache_show_dev_rx->name,
			flow_info->cache_show_dev_tx->name,
			&flow_entry->s.ip_saddr,
			htons(flow_entry->s.l4_sport),
			&flow_entry->s.ip_daddr,
			htons(flow_entry->s.l4_dport),
			flow_entry->s.ip_proto,
			flow_entry->s.pppoe_sid,
			flow_entry->s.vlan_id,
			&flow_info->ip_saddr,
			ntohl(flow_info->ports) >> 16,
			&flow_info->ip_daddr,
			ntohl(flow_info->ports) & 0xFFFF,
			flow_info->ip_proto,
			pppoe_sid,
			flow_info->vlan_tag,
			flow_info->ip_tos,
#ifdef CVM_QOS_POLICER
			flow_info->nfmark,
#else
			0,
#endif
#ifdef FLOW_COUNTERS
			atomic_long_read(&flow_info->rx.packets),
                        atomic_long_read(&flow_info->rx.bytes),
#else
			0UL,
                        0UL,
#endif
#ifdef DPI
                        flow_info->dpi_cat,
                        flow_info->dpi_app,
                        flow_info->dpi_flags
#else
			0,
			0,
			0
#endif
			);

	seq_printf(file, "-----------------------------------------------------------------------------------------------------------------------------------------------------------------|\n");
}

static void print_flow_entry(struct seq_file *file)
{
	cvm_ipfwd_flow_bucket_t *bucket     = NULL;
	cvm_ipfwd_flow_entry_t  *flow_entry = NULL;
	cvm_ipfwd_flow_info_t *flow_info = NULL;
	int bkt_no, ent_no;

	for (bkt_no = 0; bkt_no < ipv4_cache_size; bkt_no++) {
		bucket = &cvm_gbl_ipv4_fwd_cache[bkt_no];

		if (bucket != NULL) {
			for (ent_no = 0; ent_no < CVM_IPFWD_ENTRIES_PER_BUCKET; ent_no++) {
				flow_entry = &bucket->entry[ent_no];

				if(!flow_entry->s.id0 || (flow_entry->s.id0 != flow_entry->s.id1))
					continue;

				if (flow_entry->s.flow_info != 0) {
					flow_info = phys_to_virt(flow_entry->s.flow_info << 2);
					print_flow_info(file, bkt_no, ent_no, flow_entry, flow_info);
				}
			}
		}
	}
}
#endif

static cvm_ipfwd_flow_bucket_t *cvm_ipfwd_alloc_cache(unsigned long lut_buckets)
{
	cvm_ipfwd_flow_bucket_t *cache = NULL;

	/* Create Forwarding cache */
	cache = (cvm_ipfwd_flow_bucket_t *)vmalloc(sizeof(cvm_ipfwd_flow_bucket_t) * lut_buckets);

	return cache;
}

static void cvm_ipfwd_init_cache(cvm_ipfwd_flow_bucket_t *cache, unsigned long lut_buckets)
{
	int i, j;
	cvm_ipfwd_flow_bucket_t *bucket;
	cvm_ipfwd_flow_entry_t *flow_entry;

        /* Initialize all entries to zero */
        for (i = 0; i < lut_buckets; i++) {
                bucket = &cache[i];
                spin_lock_init(&bucket->hdr.wr_lock);
                for (j = 0; j < CVM_IPFWD_ENTRIES_PER_BUCKET; j++) {
                        flow_entry = &bucket->entry[j];
                        flow_entry->u.word0 = 0;
                        flow_entry->u.word1 = 0;
                        flow_entry->u.word2 = 0;
                        flow_entry->u.word3 = 0;
                        flow_entry->u.word4 = 0;
                        flow_entry->u.word5 = 0;
                        flow_entry->u.word6 = 0;
                }
        }
}

static int ipv4_fwd_cache_size_show(struct seq_file *file, void *ptr)
{
	seq_printf(file, "%u\n", ipv4_cache_size);
	return 0;
}

static int ipv4_fwd_cache_size_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_fwd_cache_size_show, NULL);
}

static ssize_t ipv4_fwd_cache_size_write(struct file *file, const char __user *input,
					 size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	cvm_ipfwd_flow_bucket_t *cache;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	/* Get new size from userspace. */
	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;
	val = simple_strtoul(buffer, NULL, 10);

	/* Check if the value is 2^n. */
	if (val == 0 || ((val & (val - 1)) != 0) || val > CVM_IPFWD_LUT_MAX) {
		printk("Unsupported IPv4 forwarding cache table size %lu (must be 2^n, at most %u)\n", val, CVM_IPFWD_LUT_MAX);
		return size;
	}

	mutex_lock(&cvm_ipfwd_table_mutex);

	/* The size didn't change - do nothing. */
	if (val == ipv4_cache_size && cvm_gbl_ipv4_fwd_cache) {
		goto err;
	}

	/* Offloading disabled - cache table will be allocated when offloading enabled. */
	if (!cvm_ipv4_fwd) {
		ipv4_cache_size = val;
		goto err;
	}

	/* Allocate the new cache, but do not replace the old cache yet. */
	cache = cvm_ipfwd_alloc_cache(val);
	if (!cache) {
		printk("IPv4 forwading cache table allocation failed (%lu entries)\n", val);
		goto err;
	}

	/* Disable offloading. */
	cvm_ipv4_fwd = false;
	clear_ipv4_bit(ipfwd_flags);
	CVMX_SYNC;
	synchronize_net();	/* let fast-path readers finish before freeing */

	/* Flush and free the cache. */
	pr_info("Flushing IPv4 cache (size changed)\n");
	cvm_ipfwd_flush_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
	vfree((void *)cvm_gbl_ipv4_fwd_cache);

	/* Initialize the new cache. */
	printk("Changing the IPv4 forwarding cache table size from %u to %lu\n", ipv4_cache_size, val);
	cvm_gbl_ipv4_fwd_cache = cache;
	ipv4_cache_size = val;
	cvm_ipfwd_init_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size);

	/* Enable offloading. */
	cvm_ipv4_fwd = true;
	set_ipv4_bit(ipfwd_flags);
	CVMX_SYNCW;
err:
	mutex_unlock(&cvm_ipfwd_table_mutex);
	return size;
}

static int ipv4_fwd_cache_show(struct seq_file *file, void *ptr)
{
#if IPFWD_CACHE_SHOW
    seq_printf(file, "\n");
    seq_printf(file, "------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|\n");
    seq_printf(file, "Cavium ip_fwd cache: (IPv4)\n");
    seq_printf(file, "======================================================================================================================================================================================================|\n");
    seq_printf(file, "| In    | Out   | Src        | Src   | Dst        | Dst   | Proto | PPPoE | VLAN |    Flow Info     |\n");
    seq_printf(file, "| Dev   | Dev   | Addr       | Port  | Addr       | Port  |       | Sess  | Tag  |------------------------------------------------------------------------------------------------------------------------------------|\n");
    seq_printf(file, "|         |           |            |       |            |       |       |       |      |  Src Addr   | Src port  | Dst Addr   | Dst port   | Proto | PPPOE Sess ID | VLAN Tag | TOS  | nfmark | Pkts Rcvd | Pkts Send       |\n");
    seq_printf(file, "======================================================================================================================================================================================================|\n");

	mutex_lock(&cvm_ipfwd_table_mutex);
	if (!cvm_ipv4_fwd || !cvm_gbl_ipv4_fwd_cache) {
		mutex_unlock(&cvm_ipfwd_table_mutex);
		return 0;
	}

	rcu_read_lock();	/* flow_info may be freed concurrently (after a grace period) */
	print_flow_entry(file);
	rcu_read_unlock();
	mutex_unlock(&cvm_ipfwd_table_mutex);

	seq_printf(file, "\n");
#endif

	return 0;
}

static int ipv4_fwd_cache_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_fwd_cache_show, NULL);
}

static ssize_t ipv4_fwd_cache_write(struct file *file, const char __user *buffer,
			            	size_t count, loff_t *ppos)
{
	char str[64], *strend;	/* longest input: "a.b.c.d port a.b.c.d port" */
	int action;
	u8 src_ip0, src_ip1, src_ip2, src_ip3;
	u8 dst_ip0, dst_ip1, dst_ip2, dst_ip3;
	u16 src_port, dst_port;
	u16 n_tokens;
	unsigned long flags;

	if(!cvm_ipv4_fwd) {
		printk(KERN_ERR"Ipv4 Ipfwd offload disabled.Please enable it and try again!!!\n");
		return count;
	}

	if (count >= sizeof(str))
		return -EINVAL;

	if (copy_from_user(str, buffer, count))
		return -EFAULT;

	str[count] = '\0';

	n_tokens = sscanf(str, "%hhu.%hhu.%hhu.%hhu %hu %hhu.%hhu.%hhu.%hhu %hu", 
															&src_ip0, &src_ip1, 
															&src_ip2, &src_ip3, 
															&src_port, 
															&dst_ip0, &dst_ip1, 
															&dst_ip2, &dst_ip3, 
															&dst_port);

	if( n_tokens == 1 ) {
		/*
		 * We received command to clear entire cache
		 * echo 0 > /proc/cavium/ipv4/cache
		 */
		action = simple_strtoul(str, &strend, 0);
		switch (action) {
		case 0:
			//printk("Flushing IPv4 flow cache: %s(%d)\n", current->comm, task_pid_nr(current));

			if (cvm_ipv4_ignore_cache_flush)
				break;

			mutex_lock(&cvm_ipfwd_table_mutex);
			if (!cvm_ipv4_fwd) {	/* disabled meanwhile */
				mutex_unlock(&cvm_ipfwd_table_mutex);
				break;
			}
			incr_ipfwd_flow_stat(IPV4_FLUSHES);
			cvm_ipv4_fwd = false;
			clear_ipv4_bit(ipfwd_flags);
			CVMX_SYNC;
			synchronize_net();	/* let fast-path readers finish before freeing */
			pr_info("\nFlushing IPv4 cache\n");
			cvm_ipfwd_flush_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
			cvm_ipv4_fwd = true;
			set_ipv4_bit(ipfwd_flags);
			CVMX_SYNCW;
			mutex_unlock(&cvm_ipfwd_table_mutex);
			break;
		default:
			pr_err("Unknown action\n");
			break;
		}
	} else if( n_tokens == 10 ) {
		/*
		 * We received src_ip src_port dst_ip dst_port
		 * to clear a specific entry
		 * echo x.x.x.x xx x.x.x.x xx > /proc/cavium/ipv4/cache
		 */
		u64 src_ip = (src_ip0 | (src_ip1<<8) | (src_ip2<<16) | (src_ip3<<24));
		u64 dst_ip = (dst_ip0 | (dst_ip1<<8) | (dst_ip2<<16) | (dst_ip3<<24));

		int i, j;
		cvm_ipfwd_flow_bucket_t *bucket;
		cvm_ipfwd_flow_entry_t *flow_entry;

		src_port = htons(src_port);
		dst_port = htons(dst_port);

		mutex_lock(&cvm_ipfwd_table_mutex);
		for (i = 0; cvm_gbl_ipv4_fwd_cache && i < ipv4_cache_size; i++) {

			bucket = &cvm_gbl_ipv4_fwd_cache[i];

			for (j = 0; j < CVM_IPFWD_ENTRIES_PER_BUCKET; j++) {

				flow_entry = &bucket->entry[j];

				if(flow_entry->s.id0 && (flow_entry->s.id0 == flow_entry->s.id1)) {

					if(src_port != flow_entry->s.l4_sport) {
						continue;
					}
					if(dst_port != flow_entry->s.l4_dport) {
						continue;
					} 
					if(src_ip != flow_entry->s.ip_saddr) {
						continue;
					} 
					if(dst_ip != flow_entry->s.ip_daddr) {
						continue;
					}

					/* irqsave: the learn path takes this lock from the tx hook */
					spin_lock_irqsave(&bucket->hdr.wr_lock, flags);

					cvm_ipfwd_entry_write_begin(flow_entry);
					if (flow_entry->s.flow_info) {
						cvm_ipfwd_free_flow_info(phys_to_virt(flow_entry->s.flow_info << 2));
					}
					cvm_ipfwd_entry_clear(flow_entry);
					cvm_ipfwd_entry_write_end(flow_entry);

					spin_unlock_irqrestore(&bucket->hdr.wr_lock, flags);
				}

			}
		}
		mutex_unlock(&cvm_ipfwd_table_mutex);
	} else {
		pr_err("Unexpected input : %s\n", str);
		pr_err("Usage:\n");
		pr_err("		<src_ip> <src_port> <dst_ip> <dst_port>\n");
	}

	return count;
}

static int cvm_ipv4_fwd_ignore_cache_flush_show(struct seq_file *file, void *ptr)
{
	seq_printf(file, "%d\n", cvm_ipv4_ignore_cache_flush);
	return 0;
}

static int ipv4_fwd_ignore_cache_flush_open(struct inode *inode, struct file *file)
{
	return single_open(file, cvm_ipv4_fwd_ignore_cache_flush_show, NULL);
}

static ssize_t ipv4_fwd_ignore_cache_flush_write(struct file *file, const char __user *buffer,
					size_t count, loff_t *ppos)
{
	char str[64], *strend;	/* input is a short number */
	int action;

	if (count >= sizeof(str))
		return -EINVAL;

	if (copy_from_user(str, buffer, count))
		return -EFAULT;

	str[count] = '\0';

	action = simple_strtoul(str, &strend, 0);
	switch (action) {
	case 0:
		printk("Enabling IPv4 flow cache flushing\n");
		cvm_ipv4_ignore_cache_flush = 0;
		break;
	case 1:
		printk("Disabling IPv4 flow cache flushing\n");
		cvm_ipv4_ignore_cache_flush = 1;
		break;
	default:
		pr_err("Unknown action\n");
		break;
	}

	return count;
}

static int ipv6_fwd_cache_size_show(struct seq_file *file, void *ptr)
{
	seq_printf(file, "%u\n", ipv6_cache_size);
	return 0;
}

static int ipv6_fwd_cache_size_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv6_fwd_cache_size_show, NULL);
}

static ssize_t ipv6_fwd_cache_size_write(struct file *file, const char __user *input,
					 size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	cvm_ipfwd_flow_bucket_t *cache;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	/* Get new size from userspace. */
	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;
	val = simple_strtoul(buffer, NULL, 10);

	/* Check if the value is 2^n. */
	if (val == 0 || ((val & (val - 1)) != 0) || val > CVM_IPV6FWD_LUT_MAX) {
		printk("Unsupported IPv6 forwarding cache table size %lu (must be 2^n, at most %u)\n", val, CVM_IPV6FWD_LUT_MAX);
		return size;
	}

	mutex_lock(&cvm_ipfwd_table_mutex);

	/* The size didn't change - do nothing. */
	if (val == ipv6_cache_size && cvm_gbl_ipv6_fwd_cache) {
		goto err;
	}

	/* Offloading disabled - cache table will be allocated when offloading enabled. */
	if (!cvm_ipv6_fwd) {
		ipv6_cache_size = val;
		goto err;
	}

	/* Allocate the new cache, but do not replace the old cache yet. */
	cache = cvm_ipfwd_alloc_cache(val);
	if (!cache) {
		printk("IPv6 forwading cache table allocation failed (%lu entries)\n", val);
		goto err;
	}

	/* Disable offloading. */
	cvm_ipv6_fwd = false;
	clear_ipv6_bit(ipfwd_flags);
	CVMX_SYNC;
	synchronize_net();	/* let fast-path readers finish before freeing */

	/* Flush and free the cache. */
	pr_info("Flushing IPv6 cache (size changed)\n");
	cvm_ipfwd_flush_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
	vfree((void *)cvm_gbl_ipv6_fwd_cache);

	/* Initialize the new cache. */
	printk("Changing the IPv6 forwarding cache table size from %u to %lu\n", ipv6_cache_size, val);
	cvm_gbl_ipv6_fwd_cache = cache;
	ipv6_cache_size = val;
	cvm_ipfwd_init_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size);

	/* Enable offloading. */
	cvm_ipv6_fwd = true;
	set_ipv6_bit(ipfwd_flags);
	CVMX_SYNCW;
err:
	mutex_unlock(&cvm_ipfwd_table_mutex);
	return size;
}

static int cvm_ipv6_fwd_ignore_cache_flush_show(struct seq_file *file, void *ptr)
{
	seq_printf(file, "%d\n", cvm_ipv6_ignore_cache_flush);
	return 0;
}

static int ipv6_fwd_ignore_cache_flush_open(struct inode *inode, struct file *file)
{
	return single_open(file, cvm_ipv6_fwd_ignore_cache_flush_show, NULL);
}

static ssize_t ipv6_fwd_ignore_cache_flush_write(struct file *file, const char __user *buffer,
					size_t count, loff_t *ppos)
{
	char str[64], *strend;	/* input is a short number */
	int action;

	if (count >= sizeof(str))
		return -EINVAL;

	if (copy_from_user(str, buffer, count))
		return -EFAULT;

	str[count] = '\0';

	action = simple_strtoul(str, &strend, 0);
	switch (action) {
	case 0:
		printk("Enabling IPv6 flow cache flushing\n");
		cvm_ipv6_ignore_cache_flush = 0;
		break;
	case 1:
		printk("Disabling IPv6 flow cache flushing\n");
		cvm_ipv6_ignore_cache_flush = 1;
		break;
	default:
		pr_err("Unknown action\n");
		break;
	}

	return count;
}

static struct ipfwd_proc_ops ipv4_cache_size_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_fwd_cache_size_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_WRITE		= ipv4_fwd_cache_size_write,
	IPFWD_PROC_RELEASE	= single_release
};

static struct ipfwd_proc_ops ipv4_cache_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_fwd_cache_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_WRITE		= ipv4_fwd_cache_write,
	IPFWD_PROC_RELEASE	= single_release,
};

static struct ipfwd_proc_ops ipv4_ignore_cache_flush_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_fwd_ignore_cache_flush_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_WRITE		= ipv4_fwd_ignore_cache_flush_write,
	IPFWD_PROC_RELEASE	= single_release
};

static struct ipfwd_proc_ops ipv6_cache_size_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv6_fwd_cache_size_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_WRITE		= ipv6_fwd_cache_size_write,
	IPFWD_PROC_RELEASE	= single_release
};

static struct ipfwd_proc_ops ipv6_cache_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv6_fwd_cache_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_WRITE		= ipv6_fwd_cache_write,
	IPFWD_PROC_RELEASE	= single_release
};

static struct ipfwd_proc_ops ipv6_ignore_cache_flush_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv6_fwd_ignore_cache_flush_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_WRITE		= ipv6_fwd_ignore_cache_flush_write,
	IPFWD_PROC_RELEASE	= single_release
};

/**
 * cvm_ipfwd_find_entry - Find entry with in the bucket.
 * @ip: ipv4 header
 * @entry: flow entry
 * @keys: protcol keys (ex: pppoe, vlan etc)
 *
 * Description: Finds the entry with in the bucket
 *
 * Returns a index of the entry with in the bucket or CVM_IPFWD_NOT_FOUND
 */
static inline int cvm_ipfwd_find_entry(cvm_ipfwd_flow_bucket_t *bucket,
					void* ip,
					cvm_ipfwd_flow_entry_t **out_entry,
					struct cvm_packet_info *cvm_info,
					bool ip6,
					cvm_ipfwd_flow_entry_t *snap)
{
	cvm_ipfwd_flow_entry_t copy, *e;
	u64 saddrhi=0, daddrhi=0, saddrlo=0, daddrlo=0;
	u32 saddr=0, daddr=0, ports=0;
	u8 proto;
	int count, idx;
	bool pppoe = false, vlan = false, vxlan = false, gre = false, greKey = false;
	int vlan_tci=0, pppoe_sid=0, vx_vni=0;
	u32 gre_key=0;
	
	if (ip6) {
		struct ipv6hdr *ipv6 = (struct ipv6hdr *)ip;

		saddrhi = *(u64 *)(&ipv6->saddr.s6_addr[0]);
		saddrlo = *((u64 *)(&ipv6->saddr.s6_addr[0]) + 1);
		daddrhi = *(u64 *)(&ipv6->daddr.s6_addr[0]);
		daddrlo = *((u64 *)(&ipv6->daddr.s6_addr[0]) + 1);
		proto = ipv6->nexthdr;
		ports = *(((u32 *) ipv6) + 10);
	} else {
		struct iphdr *ipv4 = (struct iphdr *)ip;

		saddr = ipv4->saddr;
		daddr = ipv4->daddr;
		ports = *((u32 *)ipv4 + ipv4->ihl);
		proto = ipv4->protocol;
	}	

	if (cvm_info->rx_pkt_flags) {
		if (test_vlan_hdr(&cvm_info->rx_pkt_flags)) {
			vlan_tci = cvm_info->vlan.h_vlan_TCI;
			vlan = true;
		}
		if (test_pppoe_hdr(&cvm_info->rx_pkt_flags)) {
			pppoe_sid = cvm_info->pppoe.sid;
			pppoe = true;
		}
		if (!ip6) {
			if (test_vxlan_hdr(&cvm_info->rx_pkt_flags)) {
				saddr = cvm_info->outer_ip4.saddr;
				daddr = cvm_info->outer_ip4.daddr;
				proto = cvm_info->outer_ip4.protocol;
				ports = (cvm_info->outer_udp.source << 16) | (cvm_info->outer_udp.dest);
				vx_vni = cvm_info->vxlan.vx_vni;
				vxlan = true;
			}
		}
		if (test_gre_hdr(&cvm_info->rx_pkt_flags)) {
			saddr = cvm_info->outer_ip4.saddr;
			daddr = cvm_info->outer_ip4.daddr;
			proto = cvm_info->outer_ip4.protocol;
			gre = true;
			if (cvm_info->gre.flags & GRE_KEY) {
				gre_key = cvm_info->gre.key;
				greKey = true;
			}
		}
	}

	for (idx = 0; idx < CVM_IPFWD_ENTRIES_PER_BUCKET; idx++) {
		u8 b0, b1, e0, e1;

		/* Take a consistent copy of the entry (see cvm_ipfwd_entry_write_begin) */
		e = &bucket->entry[idx];
		for (count = CVM_IPFWD_ENTRY_RETRIES; count >= 0; count--) {
			cvm_ipfwd_entry_ids(e, &b0, &b1);
			if (b0 != b1)
				continue;		/* write in progress */
			smp_rmb();
			copy.u.word0 = READ_ONCE(e->u.word0);
			copy.u.word1 = READ_ONCE(e->u.word1);
			copy.u.word2 = READ_ONCE(e->u.word2);
			copy.u.word3 = READ_ONCE(e->u.word3);
			copy.u.word4 = READ_ONCE(e->u.word4);
			copy.u.word5 = READ_ONCE(e->u.word5);
			copy.u.word6 = READ_ONCE(e->u.word6);
			smp_rmb();
			cvm_ipfwd_entry_ids(e, &e0, &e1);
			if (e0 == b1)
				break;			/* no writer overlapped the copy */
		}

		if (count >= 0) {
			/* Test current entry -- compare 5-tuple */
			/* include protocol keys (pppoe, vlan) if present */

		    if(ports != ((copy.s.l4_dport << 16) | (copy.s.l4_sport))) {
		    	continue;
		    }

			if(ip6 && !gre) {
			    if((saddrhi != copy.s.ip_saddrhi) ||
			    	(saddrlo != copy.s.ip_saddrlo) ||
			    	(daddrhi != copy.s.ip_daddrhi) ||
			    	(daddrlo != copy.s.ip_daddrlo)) {
			    	continue;
			    }
			} else if((saddr != copy.s.ip_saddr) ||
		    			(daddr != copy.s.ip_daddr)) {
				continue;
		    }
		    
		    if((proto != copy.s.ip_proto)) {
		    	continue;
		    }

		    if((pppoe ? (pppoe_sid != copy.s.pppoe_sid) : 0)) {
		    	continue;
		    }

		    if((vlan ? (vlan_tci != copy.s.vlan_id) : 0)) {
		    	continue;
		    }

		    if(!ip6 && (greKey ? (gre_key != copy.s.gre_key) : 0)) {
		    	continue;
		    }

		    if((vxlan ? (vx_vni != copy.s.vx_vni) : 0)) {
		    	continue;
		    }

			*out_entry = e;
			if (snap)
				*snap = copy;
			return idx;
		}
	}

	/* If we get here, entry was not found */
	*out_entry = NULL;
	return CVM_IPFWD_NOT_FOUND;
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

/**
 * Slow-path: Check bucket header timestamp to see whether bucket can be
 * updated. 
 *
 * @param *bucket ptr to hash bucket
 *
 * @return 0: this bucket cannot be updated
 * @return 1: this bucket can be updated
 */
int cvm_ipfwd_check_bucket_timestamp(cvm_ipfwd_flow_bucket_t *bucket)
{
    uint64_t old = bucket->hdr.timestamp;
    uint64_t new = (cvmx_get_cycle() >> 16) & 0xffff;

    if ((new - old) < 8) 
        return 0;

    /* Time to punt packet to Linux --
     * update bucket header timestamp (without locking.) */
    *(uint16_t*)&bucket->hdr.timestamp = new;
    CVMX_SYNCWS;
    return 1;
}

/**
 * Function to randomly return TRUE/FALSE.
 */
static inline int cvm_ipfwd_random_select(void)
{
	return (((cvmx_get_cycle() >> CVM_IPFWD_RND_SHIFT) & CVM_IPFWD_RND_MSK) == CVM_IPFWD_RND_VAL);
}


/**
 * Slow-path: Check bucket timestamp.
 *
 * @param *bucket ptr to hash bucket
 *
 */
#ifdef CONFIG_NETFILTER
/*
 * Packets of an offloaded flow bypass conntrack, so its TCP window tracking
 * goes stale. When the flow comes back to the slow path (entry expired or a
 * random sample), conntrack judges the current sequence numbers against that
 * old window, marks them INVALID, and a firewall that doesn't accept them
 * (e.g. a zone with forward=REJECT) resets the connection. Seen on an ER-4:
 * offloaded inter-VLAN TCP died at exactly 16 s (the entry lifetime).
 *
 * Do what mainline's flowtable does on teardown (flow_offload_fixup_tcp()):
 * clear td_maxwin so conntrack re-learns the window from the next packet it
 * sees. UBNT instead set nf_conntrack_tcp_be_liberal=1 for every connection.
 */
static inline void cvm_ipfwd_ct_tcp_fixup(struct nf_conn *ct)
{
	if (nf_ct_protonum(ct) != IPPROTO_TCP)
		return;
	spin_lock_bh(&ct->lock);
	ct->proto.tcp.seen[0].td_maxwin = 0;
	ct->proto.tcp.seen[1].td_maxwin = 0;
	spin_unlock_bh(&ct->lock);
}
#endif

static void cvm_ipfwd_mark_packet(void *ip, void *bucket, struct cvm_packet_info *cvm_info, bool ip6)
{
	struct tcphdr *tcp;
	struct iphdr *ipv4;	
	struct ipv6hdr_new *ipv6;	
	cvm_info->bucket = (void *)bucket;
	cvm_info->cookie = IPFWD_COOKIE_VALUE;
	
	if (ip6) {
		ipv6 = (struct ipv6hdr_new *)ip;
		cvm_info->cvmip6.saddrhi     = ipv6->saddrhi;
		cvm_info->cvmip6.saddrlo     = ipv6->saddrlo;
		cvm_info->cvmip6.daddrhi     = ipv6->daddrhi;
		cvm_info->cvmip6.daddrlo     = ipv6->daddrlo;
		cvm_info->cvmip6.nexthdr     = ipv6->nexthdr;
		cvm_info->cvmip6.payload_len = ipv6->payload_len;
		/*TODO: 10: sizeof(ip6_hdr)/sizeof(uint32_t)) */
		((u32 *)&(cvm_info->cvmip6))[10] = ((u32 *)ipv6)[10];

		/* If TCP, cache also sequence number and acknowlegment number */
		if (ipv6->nexthdr == IPPROTO_TCP) {
			tcp = (struct tcphdr *) ((u32 *)ipv6 + 10);
			/*TODO: 10: sizeof(ip6_hdr)/sizeof(uint32_t)) */
			cvm_info->seq = tcp->seq;
			cvm_info->ack_seq = tcp->ack_seq;
		}
	} else {
		ipv4 = (struct iphdr *)ip;
		cvm_info->cvmip.saddr = ipv4->saddr;
		cvm_info->cvmip.daddr = ipv4->daddr;
		cvm_info->cvmip.protocol = ipv4->protocol;
		cvm_info->cvmip.tot_len = ipv4->tot_len;
		cvm_info->cvmip.ihl = ipv4->ihl;
		((u32 *)&(cvm_info->cvmip))[ipv4->ihl] = ((u32 *)ipv4)[ipv4->ihl];

		if (ipv4->protocol == IPPROTO_TCP) {
			tcp = (struct tcphdr *) ((u32 *)ipv4 + ipv4->ihl);
			cvm_info->seq = tcp->seq;
			cvm_info->ack_seq = tcp->ack_seq;
		}

#ifdef CVM_IPFWD_FRAG_SUPPORT
		/* If First fragment (other fragments dont come here), 
		 * add fragment bucket info as well */
		if (ipv4->frag_off & IP_MF) {
			int idx = platform_get_hash_frag_bucket(ipv4); 
			cvm_ipfwd_flow_bucket_t *frag_bucket = &cvm_gbl_ipv4_fwd_cache[idx];
			cvm_info->frag_bucket = (void *)frag_bucket;
			cvm_info->cvmip.id = ipv4->id;
	   	}
#endif

	}
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

static inline uint16_t cvm_ipfwd_generic_checksum(uint8_t *ptr, int len)
{
	uint64_t sum = 0;
	
	while(len > 3){
	
		sum += *(uint32_t*)ptr;
		ptr +=4;
		len -=4;
	}
	if(len > 1){
		sum += *(uint16_t *)ptr;
		len -= 2;
	}
	if(len)
		sum += *ptr;

	while(sum >> 32)
		sum = (uint32_t)sum + (sum >> 32);
	
	while(sum >> 16)
		sum = (uint16_t)sum + (sum >> 16);
	
	return ((uint16_t) (sum ^ 0xffff));	
}
uint16_t gre_cvm_ipfwd_calculate_ip_header_generic_checksum(uint8_t *ptr, int len)
{
	return	cvm_ipfwd_generic_checksum(ptr,len);

}

void l4_incremental_checksum(struct iphdr *ip, struct tcphdr *l4hdr, cvm_ipfwd_flow_info_t *flow_info){
        u32 old_sum, new_sum;
        u32 new_checksum;
        u16 *ptr;

        ptr = (u16*)ip + 6;
        old_sum = ip->protocol;
        old_sum += ptr[0];
        old_sum += ptr[1];
        old_sum += ptr[2];
        old_sum += ptr[3];

        ptr = (u16*)l4hdr;
        old_sum += ptr[0];
        old_sum += ptr[1];

        old_sum = (u16)old_sum + (old_sum >> 16);
        old_sum = (u16)old_sum + (old_sum >> 16);

        new_sum = flow_info->ip_proto;
        new_sum += (u16)flow_info->ip_saddr + (flow_info->ip_saddr >> 16);
        new_sum += (u16)flow_info->ip_daddr + (flow_info->ip_daddr >> 16);
        new_sum += (u16)flow_info->ports + (flow_info->ports >> 16);

        new_sum = (u16)new_sum + (new_sum >> 16);
        new_sum = (u16)new_sum + (new_sum >> 16);

        if(ip->protocol == IPPROTO_TCP){

                ptr = (u16*)l4hdr + 8;
        }

        else if(ip->protocol == IPPROTO_UDP){

                ptr = (u16*)l4hdr + 3;
		if(*ptr == 0)
                        return;
        }

	new_checksum =  (*ptr ^ 0xffff ) + (old_sum ^ 0xffff ) + new_sum  ;
	new_checksum = (u16)new_checksum + (new_checksum >> 16);
	new_checksum = (u16)new_checksum + (new_checksum >> 16);

	//printk("Old checksum = %x  New checksum = %x\n", *ptr, (new_checksum ^ 0xffff));
	*ptr = (new_checksum ^ 0xffff);
}

void l4_incremental_checksum_ip6(struct ipv6hdr *ip, struct tcphdr *l4hdr, cvm_ipfwd_flow_info_t *flow_info){

        u32 old_sum, new_sum;
        u32 new_checksum;
        u16 *ptr;
        u16 *temp;

        ptr = (u16*)&ip->saddr.s6_addr[0];
   //     ptr = (u16*)ip + 4;
        old_sum = ip->nexthdr;
        old_sum += ptr[0];
        old_sum += ptr[1];
        old_sum += ptr[2];
        old_sum += ptr[3];
	old_sum += ptr[4];
        old_sum += ptr[5];
        old_sum += ptr[6];
        old_sum += ptr[7];

        ptr = (u16*)&ip->daddr.s6_addr[0]; 
	old_sum += ptr[0];
        old_sum += ptr[1];
        old_sum += ptr[2];
        old_sum += ptr[3];
	old_sum += ptr[4];
        old_sum += ptr[5];
        old_sum += ptr[6];
        old_sum += ptr[7];

        ptr = (u16*)l4hdr;
        old_sum += ptr[0];
        old_sum += ptr[1];

        old_sum = (u16)old_sum + (old_sum >> 16);
        old_sum = (u16)old_sum + (old_sum >> 16);

        new_sum = flow_info->ip_proto;
	temp = (u16*)&flow_info->ip_saddrhi;
        new_sum += temp[0]; 
        new_sum += temp[1]; 
        new_sum += temp[3]; 
        new_sum += temp[4]; 

	temp = (u16*)&flow_info->ip_saddrlo; 
        new_sum += temp[0]; 
        new_sum += temp[1]; 
        new_sum += temp[2]; 
        new_sum += temp[3]; 

	temp = (u16*)&flow_info->ip_daddrhi ; 
        new_sum += temp[0]; 
        new_sum += temp[1]; 
        new_sum += temp[2]; 
        new_sum += temp[3]; 

	temp = (u16*)&flow_info->ip_daddrlo; 
        new_sum += temp[0]; 
        new_sum += temp[1]; 
        new_sum += temp[2]; 
        new_sum += temp[3]; 
	
	temp = (u16*)&flow_info->ports; 
        new_sum += temp[0]; 
        new_sum += temp[1]; 

        new_sum = (u16)new_sum + (new_sum >> 16);
        new_sum = (u16)new_sum + (new_sum >> 16);


        if(ip->nexthdr == IPPROTO_TCP){

                ptr = (u16*)l4hdr + 8;
        }

        else if(ip->nexthdr == IPPROTO_UDP){

                ptr = (u16*)l4hdr + 3;
                if(*ptr == 0)
                        return;
        }

	new_checksum =  (*ptr ^ 0xffff ) + (old_sum ^ 0xffff ) + new_sum  ;
	new_checksum = (u16)new_checksum + (new_checksum >> 16);
	new_checksum = (u16)new_checksum + (new_checksum >> 16);

	//  printk("Old checksum = %x  New checksum = %x\n", *ptr, (new_checksum ^ 0xffff));
	*ptr = (new_checksum ^ 0xffff);
}



/**
 * Walks through all entries in a bucket.  Returns an index to the
 * oldest entry and populates a flow_entry structure.
 *
 * Note! Bucket must be locked prior to calling this function 
 *
 * @param *bucket bucket pointer
 * @param *entry pointer to a flow_entry structure (output).  The
 *               matching flow_entry will be copied into this structure.
 * @return idx matching entry index (within bucket)
 */
int cvm_ipfwd_get_free_entry(cvm_ipfwd_flow_bucket_t *bucket, cvm_ipfwd_flow_entry_t **entry)
{
#ifdef CVM_IPFWD_FRAG_SUPPORT
    int idx = -1, i;
#else 
    int idx = 0, i;
#endif
    uint64_t min = ~0ull;
    cvm_ipfwd_flow_entry_t *entry_ptr;

    for (i = 0; i < CVM_IPFWD_ENTRIES_PER_BUCKET; i++)
    {
        entry_ptr = &bucket->entry[i];
#ifdef CVM_IPFWD_FRAG_SUPPORT
        if (entry->s.l4_dport && (entry_ptr->s.l4_dport != 0xDEAD))
		continue;
#endif
        if (entry_ptr->s.timestamp < min)
        {
		min = entry_ptr->s.timestamp;
		idx = i;
        }
    }

#ifdef CVM_IPFWD_FRAG_SUPPORT
    if (idx == -1) {
    	for (i = 0; i < CVM_IPFWD_ENTRIES_PER_BUCKET; i++)
    	{
        	entry_ptr = &bucket->entry[i];
        	if (entry_ptr->s.timestamp < min)
        	{
            		min = entry_ptr->s.timestamp;
            		idx = i;
        	}
    	}
    }
#endif

    /* Copy found entry */
    *entry = &bucket->entry[idx];
    return idx;
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
static void cvm_ipfwd_setup_entry(struct cvm_packet_info *cvm_info, cvm_ipfwd_flow_entry_t *entry, bool ip6)
{
	u32 ports;

	cvm_ipfwd_entry_write_begin(entry);

	/* Free flow_info buf if one exists (after a grace period) */
	if (entry->s.flow_info)
		cvm_ipfwd_free_flow_info(phys_to_virt(entry->s.flow_info << 2));

	/* Clear entry, flow_info included (set by the caller in its own write section) */
	cvm_ipfwd_entry_clear(entry);

	if (ip6) {
		struct ipv6hdr_new *rx_ipv6 = (struct ipv6hdr_new *)&cvm_info->cvmip6;
		
		entry->s.ip_proto = rx_ipv6->nexthdr;
		entry->s.ip_saddrhi = rx_ipv6->saddrhi;
		entry->s.ip_saddrlo = rx_ipv6->saddrlo;
		entry->s.ip_daddrhi = rx_ipv6->daddrhi;
		entry->s.ip_daddrlo = rx_ipv6->daddrlo;
		ports = *((u32 *)rx_ipv6 + 10);
	} else {
		struct iphdr *rx_ipv4 = (struct iphdr *)&cvm_info->cvmip;
		
		entry->s.ip_proto = rx_ipv4->protocol;
		entry->s.ip_saddr = rx_ipv4->saddr;
		entry->s.ip_daddr = rx_ipv4->daddr;
		ports = *((u32 *)rx_ipv4 + rx_ipv4->ihl);
	}

	entry->s.l4_dport = ports >> 16;
	entry->s.l4_sport = ports & 0xffff;

	entry->s.cache_flush_stamp = cvm_gbl_ipfwd_cache_flush_stamp;

	if (test_vlan_hdr(&cvm_info->rx_pkt_flags))
		entry->s.vlan_id = cvm_info->vlan.h_vlan_TCI;

	if (test_pppoe_hdr(&cvm_info->rx_pkt_flags))
		entry->s.pppoe_sid = cvm_info->pppoe.sid;

	/* override the entries in case of vxlan with outer ip and udp headers */
	if (!ip6) {
		if (test_vxlan_hdr(&cvm_info->rx_pkt_flags)) {
			entry->s.ip_saddr = cvm_info->outer_ip4.saddr;
			entry->s.ip_daddr = cvm_info->outer_ip4.daddr;
			entry->s.ip_proto = cvm_info->outer_ip4.protocol;
			entry->s.l4_sport = cvm_info->outer_udp.source;
			entry->s.l4_dport = cvm_info->outer_udp.dest;
			entry->s.vx_vni = cvm_info->vxlan.vx_vni;
		}
	}
	if(test_gre_hdr(&cvm_info->rx_pkt_flags)){
		entry->s.ip_saddr = cvm_info->outer_ip4.saddr;
		entry->s.ip_daddr = cvm_info->outer_ip4.daddr;
		entry->s.ip_proto = cvm_info->outer_ip4.protocol;
		if(cvm_info->gre.flags & GRE_KEY)
			entry->s.gre_key = cvm_info->gre.key;
	}

	cvm_ipfwd_entry_write_end(entry);
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
static void cvm_ipfwd_setup_flow_info(struct sk_buff *skb, void *ip,
					cvm_ipfwd_flow_info_t *flow_info,
					struct cvm_packet_info *cvm_info,
					bool ip6)
{
	u8 *ptr;
	struct ethhdr *eth;
	struct vlan_ethhdr *vh;
	struct pppoe_hdr *ph;
#if IPFWD_ENABLE_FILTER
	struct tcphdr *th;
	filter_keys_t fkeys = { 0 };
#endif
	struct iphdr *ipv4;
	struct ipv6hdr *ipv6;
	struct net_device *dev = skb->dev;
	u64 *saddr, *daddr;
	int l2_len;
	
	/* set flow mtu */
	flow_info->mtu = dev->mtu;

	ptr = flow_info->l2_hdr;
	eth = (struct ethhdr *)skb->data;	
	memcpy(ptr, eth, ETH_HLEN);

	ptr += ETH_HLEN;
	l2_len = ETH_HLEN;
	flow_info->pppoe_offset = ETH_HLEN;
	flow_info->ip_offset = ETH_HLEN;
	
	/* copy vlan info to flow info, if exists */
	if (test_vlan_hdr(&cvm_info->tx_pkt_flags)) {
		if ( PLATFORM_VLAN_HDR_IN_PKT ) {
			vh = (struct vlan_ethhdr *)flow_info->l2_hdr;
			vh->h_vlan_proto = ETH_P_8021Q;
			vh->h_vlan_TCI = platform_vlan_tx_tag_get(skb);
			vh->h_vlan_encapsulated_proto = eth->h_proto;
			ptr += VLAN_HLEN;
			l2_len += VLAN_HLEN;
			flow_info->ip_offset += VLAN_HLEN;
			flow_info->pppoe_offset += VLAN_HLEN;
		}

		flow_info->vlan_tag = platform_vlan_tx_tag_get(skb);
		flow_info->vlan_proto = skb->vlan_proto;
		set_vlan_hdr(&flow_info->pkt_flags);
	}
	if (!ip6) {
		if (test_vxlan_hdr(&cvm_info->tx_pkt_flags)) {
			struct iphdr *out_ip = (struct iphdr *)(skb->data + ETH_HLEN);

			/* copy outer ip + outer udp + vxlan hdrs */
			memcpy(ptr, out_ip, VXLAN_HEADROOM);
			ptr += VXLAN_HEADROOM;
			l2_len += VXLAN_HEADROOM;
			set_vxlan_hdr(&flow_info->pkt_flags);
		}
	}
	/* copy pppoe hdr, if exists */
	if (test_pppoe_hdr(&cvm_info->tx_pkt_flags)) {
		ph = (struct pppoe_hdr *)(skb->data + ETH_HLEN);		
		if (skb->protocol == ETH_P_8021Q)
			ph = (struct pppoe_hdr *)(skb->data + ETH_HLEN + VLAN_HLEN);
		
		memcpy(ptr, ph, PPPOE_SES_HLEN);
		ptr += PPPOE_SES_HLEN;
		l2_len += PPPOE_SES_HLEN;
		flow_info->ip_offset += PPPOE_SES_HLEN;

		//flow_info->mtu -= PPPOE_SES_HLEN;
		set_pppoe_hdr(&flow_info->pkt_flags);
	}
	if (test_gre_hdr(&cvm_info->tx_pkt_flags)) {
		struct iphdr *out_ip = (struct iphdr *)(skb->data + ETH_HLEN);
		struct gre_base_hdr *gre_hdr = (struct gre_base_hdr*)((u32 *)out_ip + out_ip->ihl);
		int gre_headroom = sizeof(struct gre_base_hdr);
		
		if(gre_hdr->flags & GRE_CSUM){
			gre_headroom += 4;
			}
		if(gre_hdr->flags & GRE_KEY){
			gre_headroom += 4;
			}
		if(gre_hdr->flags & GRE_SEQ){
			gre_headroom += 4;
			}
		memcpy(ptr, out_ip, sizeof(struct iphdr) + gre_headroom);
		ptr += sizeof(struct iphdr) + gre_headroom;
		l2_len += sizeof(struct iphdr) + gre_headroom;
		set_gre_hdr(&flow_info->pkt_flags);
		flow_info->mtu -= sizeof(struct iphdr) + gre_headroom;
		flow_info->ip_offset += sizeof(struct iphdr) + gre_headroom;
	}


	flow_info->l4_offset = flow_info->ip_offset + sizeof(struct iphdr);
	flow_info->l2_len = l2_len;
	flow_info->out_flow = skb->protocol;
	if (ip6) {
		ipv6 = (struct ipv6hdr *)ip;
		
		saddr = (u64 *)&ipv6->saddr.s6_addr[0];
		flow_info->ip_saddrhi = *saddr;
		saddr++;
		flow_info->ip_saddrlo = *saddr;
		daddr = (u64 *)&ipv6->daddr.s6_addr[0];
		flow_info->ip_daddrhi = *daddr;
		daddr++;
		flow_info->ip_daddrlo = *daddr;
		flow_info->ip_proto = ipv6->nexthdr;
		flow_info->ports = *((u32 *)((u8 *)ipv6 + sizeof(struct ipv6hdr)));
	} else {
		ipv4 = (struct iphdr *)ip;
		
		flow_info->ip_saddr = ipv4->saddr;
		flow_info->ip_daddr = ipv4->daddr;
		flow_info->ip_proto = ipv4->protocol;
		flow_info->ports = *((u32 *)ipv4 + ipv4->ihl);
		
		flow_info->ip_tos = ipv4->tos;
	}
	flow_info->dev = dev;
	flow_info->oct_odev = dev->is_cvm_dev;

#ifdef CVM_QOS_POLICER
	flow_info->nfmark = skb->mark & 0x7;
#endif

#if IPFWD_ENABLE_FILTER
	/* set flow action to BYPASS if bit:31 in skb->mark is set */
	if (skb->mark & IPFWD_MARK_MASK) {
		flow_info->action = IPFWD_BYPASS;
		skb->mark &= ~IPFWD_MARK_MASK;
	}

	/* setup flow action based on (src, dst ports and mark fields ) */
	if (atomic_read(&cvm_ipfwd_filter)) {
		if (ip6)
			th = (struct tcphdr *) ((u8 *)ipv6 + sizeof(struct ipv6hdr));
		else
			th = (struct tcphdr *) ((uint32_t *)ipv4 + ipv4->ihl);
		memset(&fkeys, 0, sizeof(filter_keys_t));
		fkeys.flags = IPFWD_FILTER_SPORT | IPFWD_FILTER_DPORT;
		fkeys.sport = htons(th->source);
		fkeys.dport = htons(th->dest);

		/* if skb has mark */
		if (skb->mark) {
			fkeys.flags |= IPFWD_FILTER_MARK;
			fkeys.mark = skb->mark;
		}

		flow_info->action = cvm_ipfwd_filter_action(&fkeys);
	}
#endif

	if (test_bonding_fastpath(&cvm_info->tx_pkt_flags)) {
		platform_set_bonding_fastpath(skb, &flow_info->pkt_flags, &flow_info->oct_odev);
	}
}

/*
 * The flow key is the 5-tuple plus VLAN/PPPoE ids, without the port the packet
 * arrived on, so a frame with a cached flow's tuple was fast-path forwarded
 * whichever port it came in on: past rp_filter, zone policy and conntrack.
 * Record the physical port each flow is learned on and only accept hits
 * from that port.
 *
 * At learn time skb_iif is the device the packet was received on after VLAN
 * untagging (e.g. eth3.30); the rx hook runs before untagging and sees the
 * physical port (eth3), so resolve through VLAN devices. The VLAN id is
 * already part of the key. Returns 0 if unknown (locally generated packet).
 */
static int cvm_ipfwd_rx_ifindex(struct sk_buff *skb)
{
	struct net_device *dev;
	int ifindex = 0;

	if (!skb->skb_iif)
		return 0;
	rcu_read_lock();
	dev = dev_get_by_index_rcu(dev_net(skb->dev), skb->skb_iif);
	while (dev && is_vlan_dev(dev))
		dev = vlan_dev_real_dev(dev);
	if (dev)
		ifindex = dev->ifindex;
	rcu_read_unlock();
	return ifindex;
}

/**
 * Helper function to verify that the tx 5 tuple also is a match
 *
 * If packet info (at the end of the packet buffer) is valid, a new
 * flow entry (and flow info) will be created for the packet.
 *
 * When in front of NAT many rx 5 tuple may match, but the tx
 * 5 tuple may be for a different client behind NAT.
 *
 * @param *skb pointer to sk_buff
 * @param *ip  pointer to ip header of tx packet
 * @param *flow_info L2 rewrite for cache entry
 */
static int is_same_flow(struct sk_buff *skb, struct iphdr *ip,
                        cvm_ipfwd_flow_info_t *flow_info)
{
    if (flow_info->ip_saddr == ip->saddr  &&
        flow_info->ip_daddr == ip->daddr &&
        flow_info->ip_proto == ip->protocol &&
        flow_info->ports == *((u32 *)ip + ip->ihl) &&
        flow_info->dev == skb->dev &&
        flow_info->ip_tos == ip->tos) {
        return 1;
    } else {
        return 0;
    }
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
static int cvm_ipfwd_ip_cache_flow(struct sk_buff *skb, void *ip, bool ip6)
{
	int idx, status;
	cvm_ipfwd_flow_entry_t *entry;
	cvm_ipfwd_flow_bucket_t *bucket;
	cvm_ipfwd_flow_info_t *iptr;
	struct iphdr *ipv4;
	struct ipv6hdr *ipv6;
	void *rx_ip;
	struct tcphdr *l4 = NULL;
	struct cvm_packet_info *cvm_info = &skb->cvm_info;
	unsigned long flags;
	int rx_ifindex;
#ifdef DPI
	u8 cat = 0;
	u16 app = 0;
	u8 dpi_flags = 0;

	if (!ip6 && cvm_ipv4_dpi) {
		dpi_flags = tx_dpi(skb, ip, &cat, &app);
	}
#endif

	/* This is for "VLAN over BOND" interface. In the past, the interfaces (VLAN over BOND)
	 * can only do VLAN offload, and the bonding processing still goes to Linux networking
	 * stack. With this change, we bypass the learning of bond master interface to make the
	 * learning down to the bond slave interface for only "VLAN over BOND" interfaces.
	 * This makes the traffic going through "VLAN over BOND" interfaces can be offloaded
	 * completely. */
	if (skb->dev->flags & IFF_MASTER &&
		(platform_vlan_tx_tag_present(skb))) {
		return 0;
	}

	/* Check whether this buffer has valid packet_info */
	if (cvm_info->bucket == NULL) {
#ifdef CVM_IPFWD_FRAG_SUPPORT
		if (cvm_info->frag_bucket == NULL)
#endif
			return 0;
	}

	rx_ifindex = cvm_ipfwd_rx_ifindex(skb);
	if (!rx_ifindex)
		return 0;
	
	if (ip6) {
		ipv6 = 	(struct ipv6hdr *)ip;
		
		rx_ip = (struct ipv6hdr *)&cvm_info->cvmip6;
		/* Verify length */
		if (((struct ipv6hdr *)rx_ip)->payload_len != ipv6->payload_len)
			return 0;
			
		if (ipv6->nexthdr == IPPROTO_TCP) {
			l4 = (struct tcphdr *)((u8 *)ipv6 + sizeof(struct ipv6hdr));
			if (cvm_info->seq != l4->seq)
				return 0;
			if (cvm_info->ack_seq != l4->ack_seq)
				return 0;
		}
#ifdef CONFIG_NETFILTER
		/* We will only cache non-helper functions   */
		{
			struct nf_conn *ct = NULL;
			enum ip_conntrack_info ctinfo;
			struct nf_conn_help *help =NULL;

			if ((ct = nf_ct_get (skb, &ctinfo)))
				if ((help = nfct_help(ct)))
					return 0;
		}
#endif

	} else {
		ipv4 = 	(struct iphdr *)ip;
		
		rx_ip = (struct iphdr *)&cvm_info->cvmip;
		if (((struct iphdr *)rx_ip)->tot_len != ipv4->tot_len)
        		return 0;

#ifdef CVM_IPFWD_FRAG_SUPPORT
	/* Not the first Fragment */
	if (ipv4->frag_off & IP_OFFSET)
		return cvm_ipfwd_frag_cache_flow(skb, cvm_info);

	/* First fragment - setup fragment cache entry*/
	if (ipv4->frag_off & IP_MF) {
		cvm_ipfwd_frag_cache_flow(skb, cvm_info);
		/* proceed to regular cache entry as well */
	}

#endif

		if (ipv4->protocol == IPPROTO_TCP) {
			l4 = (struct tcphdr *) ((u32 *)ipv4 + ipv4->ihl);
        		if (cvm_info->seq != l4->seq)
            			return 0;
        		if (cvm_info->ack_seq != l4->ack_seq)
            			return 0;
			if (l4->syn || l4->fin || l4->rst)
				return 0;
		}
	}

#ifdef CONFIG_NETFILTER
	/* We will only cache non-helper functions   */
	{
		struct nf_conn *ct = NULL;
		enum ip_conntrack_info ctinfo;
		struct nf_conn_help *help =NULL;


		if ((ct = nf_ct_get (skb, &ctinfo))) {
			if ((help = nfct_help(ct)))
				return 0;
			cvm_ipfwd_ct_tcp_fixup(ct);
		}
	}
#endif

	bucket = cvm_info->bucket;

	/* packet_info valid -> lock bucket */
	spin_lock_irqsave(&bucket->hdr.wr_lock, flags);

	/* See if a matching entry already exists */
	idx = cvm_ipfwd_find_entry(bucket, rx_ip, &entry, cvm_info, ip6, NULL);
	if (idx == CVM_IPFWD_NOT_FOUND) {
		incr_ipfwd_flow_stat(ip6 ? IPV6_CREATE_FLOW_NOT_FOUND : IPV4_CREATE_FLOW_NOT_FOUND);

		idx = cvm_ipfwd_get_free_entry(bucket, &entry); /* Find available entry (replace oldest) */

		/* If the entry-to-be-replaced was just created, don't replace it */
		if (cvm_ipfwd_check_timestamp_just_created(entry->s.timestamp)) {
			incr_ipfwd_flow_stat(ip6 ? IPV6_CREATE_FLOW_NOT_FOUND_JUST_CREATED : IPV4_CREATE_FLOW_NOT_FOUND_JUST_CREATED);
			goto done;
		}

		status = cvm_ipfwd_check_timestamp(entry->s.timestamp, entry->s.cache_flush_stamp);
		if (entry->s.timestamp && status != CVM_IPFWD_EXPIRED) {
			incr_ipfwd_flow_stat(ip6 ? IPV6_CREATE_FLOW_NOT_FOUND_REPLACED_NON_EXPIRED : IPV4_CREATE_FLOW_NOT_FOUND_REPLACED_NON_EXPIRED);
		} else {
			incr_ipfwd_flow_stat(ip6 ? IPV6_CREATE_FLOW_NOT_FOUND_REPLACED_EXPIRED : IPV4_CREATE_FLOW_NOT_FOUND_REPLACED_EXPIRED);
		}

		/* set entry fields -- free flow info ptr if one exists */
		cvm_ipfwd_setup_entry(cvm_info, entry, ip6);
	} else {
		incr_ipfwd_flow_stat(ip6 ? IPV6_CREATE_FLOW_FOUND : IPV4_CREATE_FLOW_FOUND);

		status = cvm_ipfwd_check_timestamp(entry->s.timestamp, entry->s.cache_flush_stamp);
		if (status == CVM_IPFWD_NEW) {
			goto done;
		}

		incr_ipfwd_flow_stat(ip6 ? IPV6_CREATE_FLOW_FOUND_REPLACED : IPV4_CREATE_FLOW_FOUND_REPLACED);
#if 0
		/* OLD & EXPIRED => setup new flow info (at least for now -- add
		 * conditional update later, if necessary) */
		if (entry.s.flow_info) {
			kfree((void *)phys_to_virt(entry.s.flow_info << 2));
			entry.s.flow_info = 0;
		}
#endif
	}

	/*
	 * New or changed flow info: never rewrite a buffer the fast path may be
	 * reading on another core. Build a new one, publish it in a write
	 * section, and free the old one after a grace period.
	 */
	iptr = entry->s.flow_info ? phys_to_virt(entry->s.flow_info << 2) : NULL;
	if (!iptr || !is_same_flow(skb, ip, iptr) || iptr->rx_ifindex != rx_ifindex) {
		cvm_ipfwd_flow_info_t *old = iptr;

		iptr = kzalloc(sizeof(cvm_ipfwd_flow_info_t), GFP_ATOMIC);
		if (!iptr) {
			goto done;
		}

		/* Setup info */
		cvm_ipfwd_setup_flow_info(skb, ip, iptr, cvm_info, ip6);
		iptr->rx_ifindex = rx_ifindex;

		/* flow info is ready now: publish it */
		cvm_ipfwd_entry_write_begin(entry);
		entry->s.flow_info = virt_to_phys(iptr) >> 2;
		cvm_ipfwd_entry_write_end(entry);
		if (old)
			cvm_ipfwd_free_flow_info(old);
	}
#ifdef DPI
    if (!ip6 && cvm_ipv4_dpi) {
        iptr->dpi_cat = cat;
        iptr->dpi_app = app;
        iptr->dpi_flags = dpi_flags;
    }
#endif
#ifdef FLOW_COUNTERS
    if (cvm_ipv4_export) {
        atomic_long_inc(&iptr->rx.packets);
        atomic_long_add(skb->len, &iptr->rx.bytes);
    }
#endif

	iptr->cache_show_dev_tx = skb->dev;

	/* make a copy of flow action in flow entry */
	entry->s.action = iptr->action;

	/* Refresh time stamp */
	entry->s.timestamp = CVM_IPFWD_TIMER_GET_TIME;

	/* Update the cache_flush_stamp value */
	entry->s.cache_flush_stamp = cvm_gbl_ipfwd_cache_flush_stamp;

	/* No need to Store entry, entry table is static array */
	//bucket->entry[idx] = *entry;

done:
	//memset(cvm_info, 0, sizeof(struct cvm_packet_info));

	spin_unlock_irqrestore(&bucket->hdr.wr_lock, flags);

	return 0;
}

#ifdef CONFIG_UBNT_E300
void  ubnt_offload_stats_upd (u16 vid, u32 rx_pkts, u32 rx_bytes,
	u32 tx_pkts, u32 tx_bytes)
{
	struct net_device *dev =  cvm_oct_get_vlan_netdev(vid);
	struct vlan_pcpu_stats *stats= NULL;

	if (!dev || !is_vlan_dev(dev))
		return;

	stats = this_cpu_ptr(vlan_dev_priv(dev)->vlan_pcpu_stats);
	u64_stats_update_begin(&stats->syncp);
	stats->rx_packets += rx_pkts;
	stats->rx_bytes += rx_bytes;
	stats->tx_packets += tx_pkts;
	stats->tx_bytes += tx_bytes;
	u64_stats_update_end(&stats->syncp);
}
#endif

static inline u32 low_level_ip_pkt_process(struct sk_buff *skb, cvmx_wqe_t *wqe,
						void *ip, struct cvm_packet_info *cvm_info, bool ip6)
{
	struct iphdr *ipv4 = NULL;
	struct ipv6hdr *ipv6 = NULL;
	cvm_ipfwd_flow_entry_t *entry = NULL;
	cvm_ipfwd_flow_entry_t snap;	/* consistent copy of *entry */
	cvm_ipfwd_flow_bucket_t *bucket = NULL;
	struct tcphdr *th;
	cvm_ipfwd_flow_info_t *flow_info;
	int idx, status, ip_offset;
	int ret = CVM_IPFWD_RET_FAILED;
	u16 in_flow = 0, out_flow = 0;
	unsigned long in_bytes = 0, out_bytes = 0;
#ifdef DPI
	bool dpi_called = false;
	uint32_t mark;
#endif

	uint16_t *gre_checksum;
	int do_gre_checksum = 0;
	struct gre_base_hdr *gre_hdr;
	u64 *p;
	
	if (ip6) {
		ipv6 = (struct ipv6hdr *)ip;
		
		if (unlikely(ipv6->version != 6))
			return CVM_IPFWD_RET_FAILED;

		if (!((ipv6->nexthdr == IPPROTO_TCP) || (ipv6->nexthdr == IPPROTO_UDP)))
			return CVM_IPFWD_RET_FAILED;
		
		th = (struct tcphdr *)((u8 *)ip + sizeof(struct ipv6hdr));
		if (ipv6->nexthdr == IPPROTO_TCP) {
			if (th->syn || th->fin || th->rst)
				goto bypass_packet;
		}
		
		if (unlikely(ipv6->hop_limit < 2))
			goto bypass_packet;

		idx = platform_get_hash_bucket(skb, ip, th, cvm_info, ip6);
		bucket = &cvm_gbl_ipv6_fwd_cache[idx];
			
	} else {
		ipv4 = (struct iphdr *)ip;
		if ((ipv4->version != 4) || (ipv4->ihl != 5))
			return CVM_IPFWD_RET_FAILED;
		if (!((ipv4->protocol == IPPROTO_TCP) || (ipv4->protocol == IPPROTO_UDP)))
			return CVM_IPFWD_RET_FAILED;

		th = (struct tcphdr *)((u32 *)ip + ipv4->ihl);

		if (ip_is_fragment(ip))
#ifdef CVM_IPFWD_FRAG_SUPPORT
			return ipv4_frag_pkt_rcv(skb, wqe, cvm_info);
#else
			return CVM_IPFWD_RET_FAILED;
#endif

		if (unlikely(ipv4->ttl < 2))
			goto bypass_packet;

		idx = platform_get_hash_bucket(skb, ip, th, cvm_info, ip6);
		bucket = &cvm_gbl_ipv4_fwd_cache[idx];
		
	}

	in_flow = skb->protocol;
	out_flow = skb->protocol;
	in_bytes = skb->len;
	out_bytes = skb->len;
	
	idx = cvm_ipfwd_find_entry(bucket, ip, &entry, cvm_info, ip6, &snap);
	if (idx == CVM_IPFWD_NOT_FOUND) {
		incr_ipfwd_flow_stat(ip6 ? IPV6_FLOW_NOT_FOUND : IPV4_FLOW_NOT_FOUND);
		goto not_found;
	} else {
		incr_ipfwd_flow_stat(ip6 ? IPV6_FLOW_FOUND : IPV4_FLOW_FOUND);
	}

	if (!ip6 && ipv4->protocol == IPPROTO_TCP) {
		if (th->syn || th->fin || th->rst)
			goto bypass_packet;
	}

	/* Match found */
	/* check its time stamp */
	status = cvm_ipfwd_check_timestamp(snap.s.timestamp, snap.s.cache_flush_stamp);
	if (status == CVM_IPFWD_EXPIRED) {
		incr_ipfwd_flow_stat(ip6 ? IPV6_FLOW_FOUND_EXPIRED : IPV4_FLOW_FOUND_EXPIRED);
		goto not_found;
	}

	if ((status != CVM_IPFWD_NEW) && (cvm_ipfwd_random_select())) {
		/* Old match found and this packet was selected to go through
		* the Linux stack.  Make sure there is not already someone
		* in this bucket doing this. */
		if (cvm_ipfwd_check_bucket_timestamp(bucket)) {
			incr_ipfwd_flow_stat(ip6 ? IPV6_FLOW_FOUND_OLD_RANDOM_BYPASS : IPV4_FLOW_FOUND_OLD_RANDOM_BYPASS);
			goto not_found;
		}
	}

#if IPFWD_ENABLE_FILTER
	/* check flow action */
	if (snap.s.action == IPFWD_BYPASS) {
		incr_ipfwd_flow_stat(ip6 ? IPV6_FLOW_FOUND_ACTION_BYPASS : IPV4_FLOW_FOUND_ACTION_BYPASS);
		goto bypass_packet;
	}
#endif

	/* If we get here, entry is not expired */
	if (snap.s.flow_info) {
		/* match found -- format header */
		flow_info = phys_to_virt(snap.s.flow_info << 2);
		prefetch(flow_info);
		prefetchw(skb);

		/* Only from the port the flow was learned on */
		if (unlikely(flow_info->rx_ifindex != skb->dev->ifindex))
			goto not_found;

		flow_info->cache_show_dev_rx = skb->dev;

#ifdef DPI
		if (!ip6 && cvm_ipv4_dpi && (flow_info->dpi_flags & DPI_FINAL)) {
			mark = is_app_int(flow_info->dpi_cat, flow_info->dpi_app);
			if (mark > 0) {
				skb->mark |= mark;
				goto bypass_packet;
			}
		}
#endif

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

		/* offset to iphdr from start of skb->data */
		ip_offset = ((u8 *)ip - skb->data);

		/* crossing MTU size */
		if (unlikely((skb->len - ip_offset) > flow_info->mtu))
			goto bypass_packet;
#ifdef DPI
                if (!ip6 && cvm_ipv4_dpi) {
                    if (flow_info->dpi_flags & DPI_NOMORE) {
                        dpi_called = true;
                    }

                    if (ipv4->daddr == flow_info->ip_daddr && !dpi_called) {
                        if (rx_dpi_1(skb, ip_offset, &flow_info->dpi_cat, &flow_info->dpi_app, &flow_info->dpi_flags) > 0) {
                            dpi_called = true;
                        }
                    }
                }
#endif
		/* Point skb data to only ip */
		skb->data = (u8 *)ip;
		skb->len -=ip_offset;

		/* Copy L2 data over IP */
		if(platform_copy_l2(skb, wqe, flow_info->l2_hdr, flow_info->l2_len) != 0) {
			skb->data -= ip_offset;
			skb->len +=ip_offset;
			goto bypass_packet;
		}
		
		skb->protocol = flow_info->out_flow;
		skb->dev = flow_info->dev;
		if (flow_info->pkt_flags) {
			if (test_vlan_hdr(&flow_info->pkt_flags)) {
				if ( ! PLATFORM_VLAN_HDR_IN_PKT ) {
					/* 5.0 dropped VLAN_TAG_PRESENT in favour of skb->vlan_present */
					__vlan_hwaccel_put_tag(skb, flow_info->vlan_proto,
							       flow_info->vlan_tag);
				}
			}

			if (test_pppoe_hdr(&flow_info->pkt_flags)) {
				struct pppoe_hdr *ph = (struct pppoe_hdr *)(skb->data + flow_info->pppoe_offset);
				ph->length = htons((skb->len - flow_info->ip_offset) + 2); /* two bytes ppp header */
			}
			if (!ip6) {
				if (test_vxlan_hdr(&flow_info->pkt_flags)) {
					struct iphdr *out_ip = (struct iphdr *)(skb->data + flow_info->ip_offset);
					struct udphdr *out_udp = (struct udphdr *)(skb->data + flow_info->l4_offset);

					out_udp->len = skb->len - flow_info->l4_offset;
					out_ip->tot_len = skb->len - flow_info->ip_offset; 
					//out_ip->id++;
					//__ip_select_ident(out_ip, skb_dst(skb), 0);
					out_ip->check = cvm_ipfwd_calculate_ip_header_checksum((u16 *)out_ip);
				}
			}
			if(test_gre_hdr(&flow_info->pkt_flags)){
				struct iphdr *out_ip = (struct iphdr*)(skb->data + ETH_HLEN);
				
				gre_hdr = (struct gre_base_hdr*)( (u8*)out_ip + sizeof(struct iphdr));
				
				if(gre_hdr->flags & GRE_CSUM){
		
					do_gre_checksum = 1;
					gre_checksum = (uint16_t*)(gre_hdr + 1);
					*gre_checksum = 0;
					platform_set_hw_ip_csum_compute(wqe, false); /* Turn off hardware checksum calculation */
					if (ip6)
						l4_incremental_checksum_ip6(ip, th, flow_info); /* Do L4 incremental checksum */
					else
						l4_incremental_checksum(ip, th, flow_info);
				}
				out_ip->tot_len = htons(skb->len - ETH_HLEN);
				out_ip->check = cvm_ipfwd_calculate_ip_header_checksum((u16 *)out_ip);
			}
			if(test_bonding_fastpath(&flow_info->pkt_flags)){
				if (ip6) {
					if (unlikely(!cvm_ipv6_bonding && (skb->dev->flags & IFF_SLAVE)))
						return CVM_IPFWD_RET_FAILED;
				} else {
					if (unlikely(!cvm_ipv4_bonding && (skb->dev->flags & IFF_SLAVE)))
						return CVM_IPFWD_RET_FAILED;
				}
				platform_process_bonding_fastpath(skb);
			}
		}
		
		if (ip6) {
			ipv6->hop_limit--;
               		/*TODO: other variants?? */
			p = (u64 *)&ipv6->saddr.s6_addr[0];
			*p = flow_info->ip_saddrhi;
			p++;
			*p = flow_info->ip_saddrlo;
			p++;
			*p = flow_info->ip_daddrhi;
			p++;
			*p = flow_info->ip_daddrlo;
			p++;

			ipv6->nexthdr = flow_info->ip_proto;
			*((u32 *) ip + 10) = flow_info->ports;
               		/* TODO: 10 - sizeof ip6 hdr in words */
            		// ip->tos = info->ip_tos;
		} else {
			if (!flow_info->oct_odev) {
				/* 
				 * Need to calculate l4 checksum as 
				 * we are not aware of hardware support.
			 	*/
				l4_incremental_checksum(ip, th, flow_info);
			}

			ipv4->ttl--;
			ipv4->saddr = flow_info->ip_saddr;
			ipv4->daddr = flow_info->ip_daddr;
			ipv4->protocol = flow_info->ip_proto;
			*((u32 *) ip + ipv4->ihl) = flow_info->ports;
			
			/*
			 * Copy over tos/dscp field.
			 * This may have been set by iptables
			 */
			ipv4->tos = flow_info->ip_tos;

			/* compute IP checksum */
			ipv4->check = cvm_ipfwd_calculate_ip_header_checksum((u16 *) ip);
		}

		if(do_gre_checksum)
			*gre_checksum = cvm_ipfwd_generic_checksum((uint8_t*)gre_hdr, skb->len - ETH_HLEN - sizeof(struct iphdr));

#ifdef CVM_IPFWD_FRAG_SUPPORT
		/* Check for First fragment case - can be added with a frag id 
		 * skipping for now */
		if (ipv4->frag_off & IP_MF)
			cvm_ipfwd_frag_cache_firstfrag(skb, ip, flow_info);
#endif

#ifdef CVM_IPFWD_MQUEUES_SUPPORT
			if (cvm_mq_en)
			{
				u8 qnum =(ip6 ? (ipv6->priority >> 1) : (ipv4->tos >> 5))&0x7;
				qnum = (~qnum)&0x7;
				skb->dev = flow_info->dev;
				platform_mq_tx(cvm_mq_cid, skb, qnum);
				ret = CVM_IPFWD_RET_SUCCESS_SLOW;
			}
			else
#endif
		if (!ip6)
			skb->cvm_info.qos_level = calculate_ipv4_skb_qos_level(skb, ip);

		out_bytes = skb->len;
		out_flow = skb->protocol;

#ifdef DPI
                if (!ip6 && cvm_ipv4_dpi) {
                    if (!dpi_called) {
                        rx_dpi_2(skb, ip, &flow_info->dpi_cat, &flow_info->dpi_app, &flow_info->dpi_flags, flow_info->l2_len);
                    }
                }
#endif

		skb->cvm_reserved = 0;

		ret = platform_skb_xmit(skb, wqe, flow_info->oct_odev, flow_info->ip_offset, ip6);
		update_ipfwd_stats(in_flow, out_flow, ret, false, in_bytes, out_bytes);

#ifdef CONFIG_UBNT_E300
		ubnt_offload_stats_upd(snap.s.vlan_id, 1, in_bytes, 0, 0);
		ubnt_offload_stats_upd(flow_info->vlan_tag, 0, 0, 1, out_bytes);
#endif

#ifdef FLOW_COUNTERS
                if (cvm_ipv4_export) {
                    atomic_long_inc(&flow_info->rx.packets);
                    atomic_long_add(in_bytes, &flow_info->rx.bytes);
                }
#endif

		return ret;
	} /* entry flow info */
not_found:
	cvm_ipfwd_mark_packet(ip, bucket, cvm_info, ip6);
#ifdef CVM_QOS_POLICER
	skb->mark = 0; /* reset nfmark before sending the packet to the stack */
#endif

bypass_packet:
	update_ipfwd_stats(in_flow, out_flow, ret, false, in_bytes, out_bytes);

	return ret;
}

static inline u32 ip_pkt_rcv(struct sk_buff *skb, cvmx_wqe_t *wqe, bool ip6)
{
	struct cvm_packet_info *cvm_info;
	struct iphdr *ipv4;
	struct ipv6hdr *ipv6;
	void *ip;	

	if(unlikely(skb->dev->type == ARPHRD_IPGRE))
		return CVM_IPFWD_RET_FAILED;

	cvm_info = &skb->cvm_info;
	ip = skb->data;

	if (ip6) {
		ipv6 = (struct ipv6hdr *)ip;
	} else {
		ipv4 = (struct iphdr *)ip;
		if (ipv4->protocol == IPPROTO_UDP) {
			struct udphdr *uh = (struct udphdr *)((u32 *)ipv4 + ipv4->ihl);
			if (uh->dest == VXLAN_DST_PORT || uh->dest == 8472) {
				struct cvm_vxlan_hdr *vxhdr = (struct cvm_vxlan_hdr *)((u8 *)uh + sizeof(struct udphdr));

				/* store vxlan tunnel ip address */
				cvm_info->outer_ip4.saddr = ipv4->saddr;	
				cvm_info->outer_ip4.daddr = ipv4->daddr;
				cvm_info->outer_ip4.protocol = ipv4->protocol;
			
				/* store outer udp */
				cvm_info->outer_udp.source = uh->source;
				cvm_info->outer_udp.dest = uh->dest;

				/* store vxlan */	
				cvm_info->vxlan.vx_vni = (vxhdr->vx_vni) >> 8;

				set_vxlan_hdr(&cvm_info->rx_pkt_flags);

				/* inner ip hdr */
				ip = skb->data + VXLAN_HEADROOM;
			}
		}
		else if (ipv4->protocol == IPPROTO_GRE){
			uint8_t gre_headroom = 4;
			struct gre_base_hdr *gre_hdr = (struct gre_base_hdr*)((u32 *)ipv4 + ipv4->ihl);
			u32 *gre_key_ptr = (u32*)(gre_hdr + 1);
	
			if(unlikely(!cvm_ipv4_gre))
				return CVM_IPFWD_RET_FAILED;

			if ((gre_hdr->protocol != htons(ETH_P_IP)) && (gre_hdr->protocol != htons(ETH_P_IPV6)))
				return CVM_IPFWD_RET_FAILED;
		
			cvm_info->outer_ip4.saddr = ipv4->saddr;
			cvm_info->outer_ip4.daddr = ipv4->daddr;
			cvm_info->outer_ip4.protocol = ipv4->protocol;
			cvm_info->gre.flags = gre_hdr->flags;

			if(gre_hdr->flags & GRE_CSUM){
				gre_headroom += 4;
				gre_key_ptr += 1;
				}
			if(gre_hdr->flags & GRE_KEY){
				gre_headroom += 4;
				cvm_info->gre.key = *gre_key_ptr;
				}
			if(gre_hdr->flags & GRE_SEQ){
				//gre_headroom += 4;
				return CVM_IPFWD_RET_FAILED; /* we don't support gre seq now */
			}
			cvm_info->gre.headroom = gre_headroom;
			set_gre_hdr(&cvm_info->rx_pkt_flags);
			if(gre_hdr->protocol == htons(ETH_P_IP)) {
				ip = (struct iphdr*)((u8*)(ipv4 + 1) + gre_headroom);
			} else {
				ip = (struct ipv6hdr*)((u8*)(ipv4 + 1) + gre_headroom);
				ip6 = true;
			}
		}
	}
	
	return low_level_ip_pkt_process(skb, wqe, ip, cvm_info, ip6);
}

static inline u32 pppoe_ses_pkt_rcv(struct sk_buff *skb, cvmx_wqe_t *wqe)
{
	struct pppoe_hdr *ph;
	struct cvm_packet_info *cvm_info;
	u8 *payload;
	void *iphdr;
	int proto, ret = CVM_IPFWD_RET_FAILED;;

	cvm_info = &skb->cvm_info;

	if (test_vlan_hdr(&cvm_info->rx_pkt_flags)) {
		ph = (struct pppoe_hdr *)(skb->data + VLAN_HLEN);
		iphdr = (skb->data + VLAN_HLEN + PPPOE_SES_HLEN);
	} else {
		ph = (struct pppoe_hdr *)skb->data;
		iphdr = (skb->data + PPPOE_SES_HLEN);
	}

	cvm_info->pppoe.sid = ph->sid;
	set_pppoe_hdr(&cvm_info->rx_pkt_flags);

	payload = (u8 *)&ph->tag[0];	
	proto = ((payload[0] << 8) + payload[1]);

	switch (proto) {
	case PPP_IP:
		if (cvm_ipv4_pppoe && cvm_ipv4_fwd)
			ret = low_level_ip_pkt_process(skb, wqe, iphdr, cvm_info, false);
		break;
	case PPP_IPV6:
		if (cvm_ipv6_pppoe && cvm_ipv6_fwd)
			ret = low_level_ip_pkt_process(skb, wqe, iphdr, cvm_info, true);
		break;
	default:
		ret = CVM_IPFWD_RET_FAILED;
		break;
	}

	return ret;
}

static inline u32 vlan_pkt_rcv(struct sk_buff *skb, cvmx_wqe_t *wqe)
{
	struct ethhdr *ehdr;
	struct vlan_hdr *vhdr;
	struct cvm_packet_info *cvm_info;
	u16 proto;
	int ret = CVM_IPFWD_RET_FAILED;

	cvm_info = &skb->cvm_info;

	if ( PLATFORM_VLAN_HDR_IN_PKT ) {
		vhdr = (struct vlan_hdr *)skb->data;
		cvm_info->vlan.h_vlan_TCI = vhdr->h_vlan_TCI & 0x0FFF;
		proto = vhdr->h_vlan_encapsulated_proto;
	} else {
		ehdr = (struct ethhdr *)((u8 *)skb->data - sizeof(struct ethhdr));
		cvm_info->vlan.h_vlan_TCI = platform_vlan_tx_tag_get(skb);
		proto = ntohs(ehdr->h_proto);
	}

	set_vlan_hdr(&cvm_info->rx_pkt_flags);

	switch (proto) {
	case ETH_P_IP:
		if (cvm_ipv4_vlan && cvm_ipv4_fwd)
			ret = low_level_ip_pkt_process(skb, wqe, (void*)(skb->data + (PLATFORM_VLAN_HDR_IN_PKT ? VLAN_HLEN : 0)), cvm_info, false);
		break;
	case ETH_P_IPV6:
		if (cvm_ipv6_vlan && cvm_ipv6_fwd)
			ret = low_level_ip_pkt_process(skb, wqe, (void*)(skb->data + (PLATFORM_VLAN_HDR_IN_PKT ? VLAN_HLEN : 0)), cvm_info, true);
		break;
	case ETH_P_PPP_SES:
		ret = pppoe_ses_pkt_rcv(skb, wqe);
		break;
	default:
		ret = CVM_IPFWD_RET_FAILED;
		break;
	}

	return ret;
}

static inline u32 low_level_pkt_rcv(struct sk_buff *skb, cvmx_wqe_t *wqe)
{
	int ret = CVM_IPFWD_RET_FAILED;

	if (unlikely(!skb))
        	return CVM_IPFWD_RET_FAILED;

	if (skb->dev->flags & IFF_LOOPBACK) {
		return CVM_IPFWD_RET_FAILED;
	}

	if (skb->dev->priv_flags & IFF_EBRIDGE) {
		return CVM_IPFWD_RET_FAILED;		
	}

	/* skip if rx pkt already marked */
	if (unlikely(skb->cvm_info.cookie))
		return CVM_IPFWD_RET_FAILED;
	skb->cvm_info.rx_pkt_flags = 0;

	/* Equivalent to old 634f531eb81f0e57417b0d8ecb9e8698c274f7a5 */
	if (unlikely(!_is_oct_dev(skb->dev) && !(skb->dev->priv_flags & IFF_BONDING)))
		return CVM_IPFWD_RET_FAILED;

	/* Skip packet if bad TCP/UDP checksum was detected by hardware. */
	if (unlikely(wqe && wqe->word2.s.L4_error &&
			wqe->word2.s.err_code == CVMX_PIP_CHK_ERR)) {
		update_ipfwd_stats(skb->protocol, 0, CVM_IPFWD_RET_FAILED, true, skb->len, skb->len);
		return CVM_IPFWD_RET_FAILED;
	}

	if (platform_vlan_tx_tag_present(skb)) {
		ret = vlan_pkt_rcv(skb, wqe);
	} else {
		switch (ntohs(skb->protocol)) {
		case ETH_P_IP:
			if (likely(cvm_ipv4_fwd))
				ret = ip_pkt_rcv(skb, wqe, false);
			break;
		case ETH_P_IPV6:
			if (likely(cvm_ipv6_fwd))
				ret = ip_pkt_rcv(skb, wqe, true);
			break;
		case ETH_P_PPP_SES:
        		ret = pppoe_ses_pkt_rcv(skb, wqe);
			break;
		case ETH_P_8021Q:
			ret = vlan_pkt_rcv(skb, wqe);
			break;
		default:
			ret = CVM_IPFWD_RET_FAILED;
			break;
		}
	}	
	return ret;
}

static inline int setup_ip_flow_cache(struct sk_buff *skb, void *ip, bool ip6)
{
        cvm_ipfwd_ip_cache_flow(skb, ip, ip6);

#ifdef CVM_QOS_POLICER
        {
            /* QoS - rate limiting */
            uint8_t policer_num = (skb->mark & 0x7);

            if (cvm_qos_policer[policer_num].is_policer_on == 1)
            {
                if ((cvm_qos_rate_limit(skb->len + CVM_QOS_POLICER_ETHERNET_HEADER_LEN, policer_num)) == 0)
                {
                    /* Packet is not rate compliant. Drop it. */
                    return -ENOMEM;
                }
            }
        }
#endif  /* CVM_QOS_POLICER */

	return 0;
}

static inline int pppoe_ses_pkt_cache(struct sk_buff *skb)
{
	int proto, ret = -1;
	struct pppoe_hdr *ph;
	u8 *payload;

	set_pppoe_hdr(&skb->cvm_info.tx_pkt_flags);

	ph = (struct pppoe_hdr *)(skb->data + ETH_HLEN);
	payload = (u8 *)&ph->tag[0];
	proto = ((payload[0] << 8) + payload[1]);

	switch (proto) {
	case PPP_IP:
		if (cvm_ipv4_pppoe && cvm_ipv4_fwd)
			ret = setup_ip_flow_cache(skb, (void*)(skb->data + ETH_HLEN + PPPOE_SES_HLEN), false);
		break;
	case PPP_IPV6:
		if (cvm_ipv6_pppoe && cvm_ipv6_fwd)
			ret = setup_ip_flow_cache(skb, (void*)(skb->data + ETH_HLEN + PPPOE_SES_HLEN), true);
		break;
	default:
		ret = -1;
		break;
	}

	return ret;
}

static inline int vlan_pkt_cache(struct sk_buff *skb)
{
	struct ethhdr *eth;
	int proto, ret = -1;

	eth = (struct ethhdr *)skb->data;
	proto = eth->h_proto;

	set_vlan_hdr(&skb->cvm_info.tx_pkt_flags);

	switch (ntohs(eth->h_proto)) {
	case ETH_P_IP:
		if (cvm_ipv4_vlan && cvm_ipv4_fwd)
			ret = setup_ip_flow_cache(skb, (void*)(skb->data + ETH_HLEN), false);
		break;
	case ETH_P_IPV6:
		if (cvm_ipv6_vlan && cvm_ipv6_fwd)
			ret = setup_ip_flow_cache(skb, (void*)(skb->data + ETH_HLEN), true);
		break;
	case ETH_P_PPP_SES:
		ret = pppoe_ses_pkt_cache(skb);
		break;
	default:
		break;
	}

	return ret;
}

static inline int ip_pkt_cache(struct sk_buff *skb, bool ip6)
{
	void *ip;
	struct iphdr *ipv4;
	struct ipv6hdr *ipv6;
	struct udphdr *uh;
	struct cvm_packet_info *cvm_info;

	/* XXX name check no longer needed with oct_dev check? */
	if (!_is_oct_dev(skb->dev) && !(skb->dev->priv_flags & IFF_BONDING))
		return -1;

	if (skb->dev->flags & IFF_POINTOPOINT)
		return -1;

	if(skb->dev->type == ARPHRD_IPGRE)
		return -1; 

	cvm_info = &skb->cvm_info;

	if (skb->dev->flags & IFF_MASTER) {
		skb->cvm_info.cookie = 0;	/* So that the packet is not hooked in future */	
		if(unlikely(!cvm_ipv4_bonding) && unlikely(!cvm_ipv6_bonding))
			return -1;
		set_bonding_fastpath(&cvm_info->tx_pkt_flags);
	}

	ip = skb_network_header(skb);

	if (ip6)
		ipv6 = (struct ipv6hdr *)ip;
	else
		ipv4 = (struct iphdr *)ip;

	cvm_info = &skb->cvm_info;
	
	if (!ip6) {
		if (ipv4->protocol == IPPROTO_UDP) {
			uh = (struct udphdr *)((u32 *)ipv4 + ipv4->ihl);
			/* UBNT Fix: YT - EOS-1579 */
			/* Dont forward DHCP traffic through the fastpath ever */
			if (unlikely(uh->dest == 67 || uh->dest == 68))
				return -1;
			else if (uh->dest == VXLAN_DST_PORT || uh->dest == 8472) {
				struct cvm_vxlan_hdr *vxhdr = (struct cvm_vxlan_hdr *)((u8 *)uh + sizeof(struct udphdr));

				/* store vxlan tunnel ip address */
				cvm_info->outer_ip4.saddr = ipv4->saddr;	
				cvm_info->outer_ip4.daddr = ipv4->daddr;
				cvm_info->outer_ip4.protocol = ipv4->protocol;

				/* store outer udp */
				cvm_info->outer_udp.source = uh->source;
				cvm_info->outer_udp.dest = uh->dest;

				/* store vxlan */
				cvm_info->vxlan.vx_vni = (vxhdr->vx_vni) >> 8;

				set_vxlan_hdr(&cvm_info->tx_pkt_flags);

				/* inner ip hdr */
				ip = (struct iphdr *)((u8 *)vxhdr + sizeof(struct cvm_vxlan_hdr) + ETH_HLEN);
			}
		}
		else if (ipv4->protocol == IPPROTO_GRE) {
				uint8_t gre_headroom = 4;
				struct gre_base_hdr *gre_hdr = (struct gre_base_hdr*)((u32 *)ipv4 + ipv4->ihl);
	
				if(unlikely(!cvm_ipv4_gre))
					return -1;

				if((gre_hdr->protocol != htons(ETH_P_IP)) && (gre_hdr->protocol != htons(ETH_P_IPV6))) 
					return -1;

				if(gre_hdr->flags & GRE_CSUM)
					gre_headroom += 4;
		
				if(gre_hdr->flags & GRE_KEY)
				gre_headroom += 4;

				if(gre_hdr->flags & GRE_SEQ)
				return -1;    // gre_headroom += 4; /* We don't support GRE seq now */

				set_gre_hdr(&cvm_info->tx_pkt_flags);

				if(gre_hdr->protocol == htons(ETH_P_IP)) 
					ip = (struct iphdr*)((u8*)(ipv4 + 1) + gre_headroom);
				else { 
					ip  = (struct ipv6hdr*)((u8*)(ipv4 + 1) + gre_headroom);
					ip6 = true;
				}
		}
	}
	return setup_ip_flow_cache(skb, ip, ip6);
}

int pkt_cache(struct sk_buff *skb)
{
	int ret = -1;

	if (unlikely(!skb))
		return -1;
	if (!skb->cvm_info.cookie)
		return -1;

	/* Dont create entry for br0 
	   but update directly the bridged interface 
	   Initially when the bridge is in the process
	   of learning it would flood to all ports in the bridge
	   Just mark entry for the skb if it is not cloned 
	*/
	if (skb->dev->priv_flags & IFF_EBRIDGE) {
		/* Routed out through a bridge: an entry on the member port loses its packets
		 * (on hardware 2026-10-16, WAN -> br-lan(eth1): fast-path transmits never reach
		 * the host). Keep these flows on the CPU, like traffic bridged in (br_input.c). */
		skb_cvm_reserve(skb, SKB_CVM_RESERVED_2);
		return -1;
	}
	
	if(skb_cloned(skb))
		return -1;

	if (unlikely((skb->cvm_reserved & SKB_CVM_RESERVED_MASK))) {
		/* Uncacheable */
		return -1;
	}

	if (!is_vlan_dev(skb->dev) && !platform_vlan_tx_tag_present(skb)) {
		switch (ntohs(skb->protocol)) {
		case ETH_P_IP:
			if (likely(cvm_ipv4_fwd))
				ret = ip_pkt_cache(skb, false);
			break;
		case ETH_P_IPV6:
			if (likely(cvm_ipv6_fwd))
				ret = ip_pkt_cache(skb, true);
			break;
		case ETH_P_PPP_SES:
			ret = pppoe_ses_pkt_cache(skb);
			break;
		default:
			ret = -1;
			break;
		}
	} else if (platform_vlan_tx_tag_present(skb)) {
		ret = vlan_pkt_cache(skb);
	}
	
	return ret;
}

u32 pkt_receive(struct sk_buff *skb)
{
	int ret;

	/* flow entries and flow_info are read locklessly: see cvm_ipfwd_free_flow_info() */
	rcu_read_lock();
	ret = low_level_pkt_rcv(skb, NULL);
	rcu_read_unlock();

	if (cvmx_likely(ret != CVM_IPFWD_RET_FAILED))
		return 0;
	else
		return -1;
}

platform_callback_result_t pkt_receive_cb(struct net_device *dev, void *wqe, struct sk_buff *skb)
{
	platform_callback_result_t ret;

	/* as in pkt_receive() */
	rcu_read_lock();
	ret = low_level_pkt_rcv(skb, (cvmx_wqe_t*) wqe);
	rcu_read_unlock();
	return ret;
}





/**
 * =============================================
 * = Cavium QoS support
 * =============================================
 */

#ifdef CVM_QOS_POLICER

static inline int cvm_qos_policer_deinit(void)
{
    remove_proc_entry("cavium_qos_stats", NULL);
    return 0;
}


static inline int cvm_qos_policer_init(void)
{
    uint64_t            depth_in_bytes                   = CVM_QOS_TB_DEPTH;
    uint8_t          policer_state[CVM_QOS_NUM_POLICERS_MAX] = { 0, 1, 1, 1,   1, 1, 1, 1 };
    /* uint8_t             policer_state[CVM_QOS_NUM_POLICERS_MAX] = { 0, 0, 0, 0,   0, 0, 0, 0 }; */
    uint64_t            rate_in_kbps [CVM_QOS_NUM_POLICERS_MAX] = { 0, 2000, 3000, 5000,   10000, 30000, 50000, 100000 };
    uint16_t            pol_num             = 0;
    cvm_qos_policer_t  *pol_info = NULL;
    int32_t             bytes_offset        = 0;

    printk("\n\nQos - Rate Limiting / Policers Initialization...\n\n");

    /* 
     * - Rate limiting rate is specified in kbps.
     * - octeon_get_clock_rate gives the clock speed in Hz.  Change the clock speed to kHz.
     * - Scale factor is 16-bits.
     * - Convert cycles_per_bit to cycles_per_byte by multiplying by 8.
     */
    cvm_qos_tb_rate_const_scaled = ((octeon_get_clock_rate()/1000) * (CVM_QOS_TB_SCALE_FACTOR * 8));

    for (pol_num=0; pol_num<CVM_QOS_NUM_POLICERS_MAX; pol_num++) 
    {
        pol_info = &cvm_qos_policer[pol_num];

        spin_lock_init(&pol_info->lock);
        memset(pol_info, 0, sizeof(cvm_qos_policer_t));

        cvm_qos_policer_set (pol_num, policer_state[pol_num], rate_in_kbps[pol_num], depth_in_bytes, bytes_offset);
    }

    /* setup proc entry for QoS policer statistics */
    {
        proc_create_data("cavium_qos_stats", 0644, NULL, &cvm_qos_stats_operations, NULL);
    }


    return 0;
}



/*
 * cvm_qos_policer_set
 * - set the token bucket rate for the specified policer_num. 
 *   - rate is specified by the user in kbps. 
 *   - this rate_in_kbps is then multiplied by a multiplier. The resultant value 
 *     is in terms of "clock cycles". 
 *   - This rate_in_cycles_per_byte is stored for token bucket calculations. 
 *     i.e. the tokens are in terms of "clock cycles".
 *   - multiplier constant = (clock_speed_in_MHz * 1000 * 8)/rate_in_kbps
 *     eg. For rate = 45, and clock_speed = 500 MHz
 *         multiplier constant = (500M)/(45k/8) = (500 * 1000 * 8)/45 
                               = 88888.8889 cycles/byte.
 * 
 * @param policer_num
 * @param is_policer_on
 * @param rate_in_kbps
 * @param depth_in_bytes
 *
 * @return void
 *
 */
static inline int cvm_qos_policer_set (int pol_num, uint8_t is_policer_on, uint64_t rate_in_kbps, uint64_t depth_in_bytes, int32_t bytes_offset)
{
    int                retval   = 0;
    cvm_qos_policer_t *pol_info = NULL;

    /* Check if pol_num is between 0 and CVM_QOS_NUM_POLICERS_MAX */
    if (! ((pol_num >= 0) && (pol_num < CVM_QOS_NUM_POLICERS_MAX)) )
    {
        printk("%s: FAILED to set policer parameters. Invalid policer number 0x%x (%d)\n", 
            __FUNCTION__, pol_num, pol_num);
        return -1;
    }

    pol_info = &cvm_qos_policer[pol_num];

    spin_lock(&pol_info->lock);

    pol_info->is_policer_on         = is_policer_on;
    pol_info->tb.depth_in_bytes_cfg = depth_in_bytes;   
    pol_info->tb.rate_in_kbps_cfg   = rate_in_kbps;
    pol_info->bytes_offset          = bytes_offset;

    if (rate_in_kbps == 0)
    {
        pol_info->tb.rate_in_cycles_per_byte = 0x0000FFFFFFFFFFFF;   /* set it to a large value to ensure no DROP */
        pol_info->tb.depth_in_cycles         = 0;
    }
    else
    {
        pol_info->tb.rate_in_cycles_per_byte = ((cvm_qos_tb_rate_const_scaled)/rate_in_kbps);
        pol_info->tb.depth_in_cycles         = (depth_in_bytes * pol_info->tb.rate_in_cycles_per_byte);
    }

    /* Re-calculate the rate_in_kbps and depth_in_bytes using rate_in_cycles_per_byte and depth_in_cycles */
    pol_info->tb.rate_in_kbps   = ((cvm_qos_tb_rate_const_scaled)/pol_info->tb.rate_in_cycles_per_byte);
    pol_info->tb.depth_in_bytes = (pol_info->tb.depth_in_cycles/pol_info->tb.rate_in_cycles_per_byte);

    spin_unlock(&pol_info->lock);

    return retval;
}



int cvm_qos_rate_limit (int32_t bytes, uint8_t policer_num)
{
    uint64_t cycles_curr    = cvmx_get_cycle();
    uint64_t cycles_elapsed = 0;
    uint64_t cycles_reqd    = 0;
    uint8_t  pass_pkt       = 0;

    cvm_qos_policer_t       *pol_info = NULL;
    cvm_qos_token_bucket_t  *tb       = NULL;
    cvm_qos_policer_stats_t *stats    = NULL;

    spin_lock(&cvm_qos_policer[policer_num].lock);

    pol_info       = &cvm_qos_policer[policer_num];
    tb             = &pol_info->tb; 
    stats          = &pol_info->stats; 

    bytes          =  bytes + pol_info->bytes_offset;
    cycles_reqd    = (tb->rate_in_cycles_per_byte * bytes);
    cycles_elapsed = ((cycles_curr - tb->cycles_prev) << CVM_QOS_TB_SCALE_FACTOR_BIT_SHIFT);

    if (cycles_elapsed > tb->depth_in_cycles) 
    {
        cycles_elapsed  = tb->depth_in_cycles;
        tb->cycles_prev = cycles_curr - (tb->depth_in_cycles >> CVM_QOS_TB_SCALE_FACTOR_BIT_SHIFT);
    }

    if (cycles_reqd <= cycles_elapsed)
    {
        tb->cycles_prev = tb->cycles_prev + (cycles_reqd >> CVM_QOS_TB_SCALE_FACTOR_BIT_SHIFT);

        /* Update stats */
        ++stats->pkts_pass;
        stats->bytes_pass = stats->bytes_pass + bytes;
        pass_pkt          = 1;
    }
    else
    {
        /* Update stats */
        ++stats->pkts_drop;
        stats->bytes_drop = stats->bytes_drop + bytes;
        pass_pkt          = 0;
    }

    tb->cycles_curr = cycles_curr;
    spin_unlock(&pol_info->lock);

    return pass_pkt;
}



/**
 * User is reading /proc/cavium_qos_stats
 *
 * @param file
 * @param ptr
 * @return
 */
static int cvm_qos_stats_show(struct seq_file *file, void *ptr)
{
    int                 retval  = 0;
    uint16_t            pol_num = 0;
    cvm_qos_policer_t  *pol     = NULL;

    /* 
     * This will force the cache to be updated by forcing the next packet to go to 
     * the Linux stack i.e. the packet will NOT have to wait for the timer to expire 
     * before being sent to the stack.
     */
    if (qos_stats_cache_flush != 0)
    {
       ++cvm_gbl_ipfwd_cache_flush_stamp;
    }

    /* If stats do not need clearing then check if any values need to be set */
    if (qos_stats_clear == 0)
    {
        if ((qos_policer >= 0) && (qos_policer < CVM_QOS_NUM_POLICERS_MAX))
        {
            retval = cvm_qos_policer_set (qos_policer, qos_policer_on, qos_policer_rate_in_kbps, qos_policer_burst_size_in_bytes, qos_policer_bytes_offset);
            if (retval == -1)
            {
               printk("%s: FAILED to update Policer parameters. Invalid qos_policer 0x%x (%d)\n", __FUNCTION__, qos_policer, qos_policer);
            }
        }
        else
        {
               printk("%s: FAILED to update Policer parameters. Invalid qos_policer 0x%x (%d)\n", __FUNCTION__, qos_policer, qos_policer);
        }
    }
    else
    {
        printk("\nClearing QoS stats: /sys/module/cavium_ip_offload/parameters/qos_stats_clear is 1\n\n");
    }


    seq_printf(file, "-------------------------------------------------------------------------------------------------------------------------------|\n");
    seq_printf(file, "Cavium QoS Statistics: \n");
    seq_printf(file, "-------------------------------------------------------------------------------------------------------------------------------|\n");
    seq_printf(file, "Pol |Pol |Offset |Burst (bytes)|   Rate (kbps)   |           Packets           |            Bytes            | Token Count     |\n");
    seq_printf(file, " #  |ON  |Bytes  |cfg   |actual| cfg    | actual | Passed       | Dropped      | Passed       | Dropped      | Current         |\n");
    seq_printf(file, "-------------------------------------------------------------------------------------------------------------------------------|\n");

    for (pol_num = 0; pol_num < CVM_QOS_NUM_POLICERS_MAX; pol_num++)
    {
        pol = &cvm_qos_policer[pol_num];

        if (qos_stats_clear)
        {
            memset(&pol->stats, 0, sizeof(cvm_qos_policer_stats_t));
        }

        if ((pol_num != 0) && (pol_num % 4) == 0)
        {
             seq_printf(file, "-------------------------------------------------------------------------------------------------------------------------------|\n");
        }
        seq_printf(file, 
                   "%3d |"         /* Policer number        */
                   "%3u |"         /* Policer - on/off      */
                   "%6d |"         /* Policer - offset bytes */
                   "%5llu |"        /* Burst (configured)    */
                   "%5llu |"        /* Burst (actual in use) */
                   "%7llu |"        /* Rate (configured)     */
                   "%7llu |"        /* Rate (actual in use)  */
                   " %12llu |"      /* Packets Passed        */
                   " %12llu |"      /* Packets Dropped       */
                   " %12llu |"      /* Bytes   Passed        */
                   " %12llu |"      /* Bytes   Dropped       */
                   " %15llu |\n",   /* Current  Cycle stamp  */
                   pol_num,
                   pol->is_policer_on,
                   pol->bytes_offset,
                   pol->tb.depth_in_bytes_cfg,
                   pol->tb.depth_in_bytes,
                   pol->tb.rate_in_kbps_cfg,
                   pol->tb.rate_in_kbps,
                   pol->stats.pkts_pass,
                   pol->stats.pkts_drop,
                   pol->stats.bytes_pass,
                   pol->stats.bytes_drop,
                   pol->tb.cycles_curr);
    }

    if (qos_stats_clear)
       qos_stats_clear = 0;

    seq_printf(file, "-------------------------------------------------------------------------------------------------------------------------------|\n");
    seq_printf(file, "\n");

    return 0;
}


/**
 * /proc/cavium_qos_stats was openned. Use the single_open iterator
 *
 * @param inode
 * @param file
 * @return
 */
static int cvm_qos_stats_open(struct inode *inode, struct file *file)
{
    return single_open(file, cvm_qos_stats_show, NULL);
}



#endif  /* CVM_QOS_POLICER */

static void cvm_ipv4_clean_proc(void)
{
	if(!ipfwd_proc.ipv4.dir) {
		printk(KERN_INFO"/proc/cavium/ipv4 aready removed.\n");
		return;
	}

	/* Remove ipv4 proc entries */
	if (ipfwd_proc.ipv4.cache)
		remove_proc_entry("cache", ipfwd_proc.ipv4.dir);	
#ifdef IPFWD_IPV4_BONDING	
	if (ipfwd_proc.ipv4.bonding)
		remove_proc_entry("bonding", ipfwd_proc.ipv4.dir);	
#endif
	if (ipfwd_proc.ipv4.gre)
		remove_proc_entry("gre", ipfwd_proc.ipv4.dir);	
	if (ipfwd_proc.ipv4.vlan)
		remove_proc_entry("vlan", ipfwd_proc.ipv4.dir);
#ifdef IPFWD_IPV4_PPPOE
	if (ipfwd_proc.ipv4.pppoe)
		remove_proc_entry("pppoe", ipfwd_proc.ipv4.dir);
#endif		
	if (ipfwd_proc.ipv4.fwd)
		remove_proc_entry("fwd", ipfwd_proc.ipv4.dir);
#ifdef FLOW_COUNTERS
	if (ipfwd_proc.ipv4.export)
		remove_proc_entry("export", ipfwd_proc.ipv4.dir);
#endif
#ifdef DPI
	if (ipfwd_proc.ipv4.dpi)
		remove_proc_entry("dpi", ipfwd_proc.ipv4.dir);
#endif
	if (ipfwd_proc.ipv4.cache_size)
		remove_proc_entry("cache_size", ipfwd_proc.ipv4.dir);
	if (ipfwd_proc.ipv4.dir)
		remove_proc_entry("ipv4", ipfwd_proc.dir);
}

static int ipv4_fwd_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv4_fwd);

	return 0;
}

static int ipv4_fwd_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_fwd_show, NULL);
}

static ssize_t ipv4_fwd_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV4 forwarding %s\n", (val ? "Enabled" : "Disabled"));

	mutex_lock(&cvm_ipfwd_table_mutex);
	if (val) {
		if (!cvm_ipv4_fwd && !cvm_gbl_ipv4_fwd_cache) {
			cvm_ipfwd_flow_bucket_t *cache;

			cache = cvm_ipfwd_alloc_cache(ipv4_cache_size);
			if (!cache) {
				pr_err("IPv4 forwading cache table allocation failed (%lu entries), continuing with offloading disabled\n", val);
				goto err;
			}

			CVMX_SYNC;
			synchronize_net();	/* let fast-path readers finish before freeing */

			cvm_gbl_ipv4_fwd_cache = cache;
			cvm_ipfwd_init_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size);

			set_ipv4_bit(ipfwd_flags);
			cvm_ipv4_fwd = true;
			CVMX_SYNCW;
		}
	} else {
		if (cvm_ipv4_fwd && cvm_gbl_ipv4_fwd_cache) {
			cvm_ipv4_fwd = false;
			clear_ipv4_bit(ipfwd_flags);

			CVMX_SYNC;
			synchronize_net();	/* let fast-path readers finish before freeing */

			cvm_ipfwd_flush_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
			vfree((void *)cvm_gbl_ipv4_fwd_cache);
			cvm_gbl_ipv4_fwd_cache = NULL;

			CVMX_SYNCW;
		}
	}

err:
	mutex_unlock(&cvm_ipfwd_table_mutex);
	return size;
}

static const struct ipfwd_proc_ops ipv4_fwd_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_fwd_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv4_fwd_write,
};

#ifdef IPFWD_IPV4_PPPOE
static int ipv4_pppoe_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv4_pppoe);

	return 0;
}

static int ipv4_pppoe_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_pppoe_show, NULL);
}

static ssize_t ipv4_pppoe_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV4 PPPOE forwarding %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_pppoe_ipv4_bit(ipfwd_flags);
		cvm_ipv4_pppoe = true;
	} else {
		clear_pppoe_ipv4_bit(ipfwd_flags);
		cvm_ipv4_pppoe = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv4_pppoe_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_pppoe_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv4_pppoe_write,
};
#endif

static int ipv4_vlan_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv4_vlan);

	return 0;
}

static int ipv4_vlan_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_vlan_show, NULL);
}

static ssize_t ipv4_vlan_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV4 VLAN forwarding %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_vlan_ipv4_bit(ipfwd_flags);
		cvm_ipv4_vlan = true;
	} else {
		clear_vlan_ipv4_bit(ipfwd_flags);
		cvm_ipv4_vlan = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv4_vlan_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_vlan_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv4_vlan_write,
};

static int ipv4_gre_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv4_gre);

	return 0;
}

static int ipv4_gre_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_gre_show, NULL);
}

static ssize_t ipv4_gre_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV4 GRE Tunnel forwarding %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_gre_ipv4_bit(ipfwd_flags);
		cvm_ipv4_gre = true;
	} else {
		clear_gre_ipv4_bit(ipfwd_flags);
		cvm_ipv4_gre = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv4_gre_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_gre_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv4_gre_write,
};

#ifdef IPFWD_IPV4_BONDING
static int ipv4_bonding_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv4_bonding);

	return 0;
}

static int ipv4_bonding_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_bonding_show, NULL);
}

static ssize_t ipv4_bonding_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV4 Bonding forwding %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_bonding_ipv4_bit(ipfwd_flags);
		cvm_ipv4_bonding = true;
	} else {
		clear_bonding_ipv4_bit(ipfwd_flags);
		cvm_ipv4_bonding = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv4_bonding_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_bonding_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv4_bonding_write,
};
#endif


#ifdef FLOW_COUNTERS
static int ipv4_export_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv4_export);

	return 0;
}

static int ipv4_export_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_export_show, NULL);
}

static ssize_t ipv4_export_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV4 export %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_export_ipv4_bit(ipfwd_flags);
		cvm_ipv4_export = true;
	} else {
		clear_export_ipv4_bit(ipfwd_flags);
		cvm_ipv4_export = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv4_export_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_export_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv4_export_write,
};
#endif

#ifdef DPI
static int ipv4_dpi_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv4_dpi);

	return 0;
}

static int ipv4_dpi_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv4_dpi_show, NULL);
}

static ssize_t ipv4_dpi_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV4 dpi %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_dpi_ipv4_bit(ipfwd_flags);
		cvm_ipv4_dpi = true;
	} else {
		clear_dpi_ipv4_bit(ipfwd_flags);
		cvm_ipv4_dpi = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv4_dpi_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv4_dpi_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv4_dpi_write,
};
#endif

static int cvm_ipv4_init_proc(void)
{
	int ret = 0;

#ifdef CONFIG_PROC_FS
	pr_info("\ncreating /proc/cavium/ipv4\n");

	/* create /proc/cavium/ipv4 directory */
	ipfwd_proc.ipv4.dir = proc_mkdir("ipv4", ipfwd_proc.dir);
	if (!ipfwd_proc.ipv4.dir) {
		pr_err("Failed to create /proc/cavium/ipv4 directory\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}

	/* create /proc/cavium/ipv4/fwd entry */
	ipfwd_proc.ipv4.fwd = proc_create_data("fwd", 0644, ipfwd_proc.ipv4.dir, &ipv4_fwd_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.fwd) {
		pr_err("Failed to create /proc/cavium/ipv4/fwd\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/fwd\n");

#ifdef IPFWD_IPV4_PPPOE
	/* create /proc/cavium/ipv4/pppoe entry */
	ipfwd_proc.ipv4.pppoe = proc_create_data("pppoe", 0644, ipfwd_proc.ipv4.dir, &ipv4_pppoe_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.pppoe) {
		pr_err("Failed to create /proc/cavium/ipv4/pppoe\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/pppoe\n");
#endif
	/* create /proc/cavium/ipv4/vlan entry */
	ipfwd_proc.ipv4.vlan = proc_create_data("vlan", 0644, ipfwd_proc.ipv4.dir, &ipv4_vlan_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.vlan) {
		pr_err("Failed to create /proc/cavium/ipv4/vlan\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/vlan\n");
	
	/* create /proc/cavium/ipv4/gre entry */
	ipfwd_proc.ipv4.gre = proc_create_data("gre", 0644, ipfwd_proc.ipv4.dir, &ipv4_gre_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.gre) {
		pr_err("Failed to create /proc/cavium/ipv4/gre\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/gre\n");
#ifdef IPFWD_IPV4_BONDING
	/* create /proc/cavium/ipv4/bonding entry */
	ipfwd_proc.ipv4.bonding = proc_create_data("bonding", 0644, ipfwd_proc.ipv4.dir, &ipv4_bonding_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.bonding) {
		pr_err("Failed to create /proc/cavium/ipv4/bonding\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/bonding\n");
#endif

#ifdef FLOW_COUNTERS
	/* create /proc/cavium/ipv4/export entry */
	ipfwd_proc.ipv4.export = proc_create_data("export", 0644, ipfwd_proc.ipv4.dir, &ipv4_export_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.export) {
		pr_err("Failed to create /proc/cavium/ipv4/export\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/export\n");
#endif

#ifdef DPI
	/* create /proc/cavium/ipv4/dpi entry */
	ipfwd_proc.ipv4.dpi = proc_create_data("dpi", 0644, ipfwd_proc.ipv4.dir, &ipv4_dpi_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.dpi) {
		pr_err("Failed to create /proc/cavium/ipv4/dpi\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/dpi\n");
#endif

	/* create /proc/cavium/ipv4/cache_size entry */
	ipfwd_proc.ipv4.cache_size = proc_create_data("cache_size", 0600, ipfwd_proc.ipv4.dir, &ipv4_cache_size_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.cache_size) {
		pr_err("Failed to create /proc/cavium/ipv4/cache_size\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/cache_size\n");

	/* create /proc/cavium/ipv4/cache entry */
	ipfwd_proc.ipv4.cache = proc_create_data("cache", 0600, ipfwd_proc.ipv4.dir, &ipv4_cache_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.cache) {
		pr_err("Failed to create /proc/cavium/ipv4/cache\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/cache\n");

	/* create /proc/cavium/ipv4/ignore_cache_flush entry */
	ipfwd_proc.ipv4.ignore_cache_flush = proc_create_data("ignore_cache_flush", 0600, ipfwd_proc.ipv4.dir, &ipv4_ignore_cache_flush_proc_fops, NULL);
	if (!ipfwd_proc.ipv4.cache) {
		pr_err("Failed to create /proc/cavium/ipv4/ignore_cache_flush\n");
		ret = -ENOMEM;
		goto ipv4_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv4/ignore_cache_flush\n");

	return 0;

ipv4_proc_failed:
	cvm_ipv4_clean_proc();
#endif
	return ret;
}

static int cvm_ipv4_fwd_init(void)
{
	int ret;

	if (!ipv4_cache_size) {
		pr_err("Module param ipv4_cache_size must be non zero.Reseting it to %d.\n", CVM_IPFWD_LUT_DEFAULT);
		ipv4_cache_size = CVM_IPFWD_LUT_DEFAULT;
	} else if (ipv4_cache_size > CVM_IPFWD_LUT_MAX) {
		pr_err("Module param ipv4_cache_size must be less than %d.Reseting it to %d.\n", CVM_IPFWD_LUT_MAX + 1,
												 CVM_IPFWD_LUT_MAX);
		ipv4_cache_size = CVM_IPFWD_LUT_MAX;
	} else if (ipv4_cache_size & (ipv4_cache_size - 1)) {
		pr_err("Module param ipv4_cache_size must be power of 2.Reseting it to %d.\n", CVM_IPFWD_LUT_DEFAULT);
		ipv4_cache_size = CVM_IPFWD_LUT_DEFAULT;
	}

	if (cvm_ipv4_fwd) { /* Just in case the default is changed... */
		cvm_ipfwd_flow_bucket_t *cache;

		cache = cvm_ipfwd_alloc_cache(ipv4_cache_size);
		if (!cache) {
			pr_err("IPv4 forwading cache table allocation failed (%u entries)\n", ipv4_cache_size);
			goto ipv4_init_failed;
		}

		cvm_gbl_ipv4_fwd_cache = cache;
		cvm_ipfwd_init_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size);
	}

	/* Create IPv4 proc entries under /proc/cavium */
	ret = cvm_ipv4_init_proc();
	if (ret) {
		pr_err("Failed to create ipv4 proc entries\n");
		goto ipv4_init_failed;
	}

	/* Enable IPV4 FWD features */
	if (cvm_ipv4_fwd)
		set_ipv4_bit(ipfwd_flags);
	if (cvm_ipv4_pppoe)
		set_pppoe_ipv4_bit(ipfwd_flags);
	if (cvm_ipv4_vlan)
		set_vlan_ipv4_bit(ipfwd_flags);
	if (cvm_ipv4_gre)
		set_gre_ipv4_bit(ipfwd_flags);
	if (cvm_ipv4_bonding)
		set_bonding_ipv4_bit(ipfwd_flags);

	return 0;

ipv4_init_failed:
	if (cvm_gbl_ipv4_fwd_cache)
		vfree((void *)cvm_gbl_ipv4_fwd_cache);
	cvm_gbl_ipv4_fwd_cache = NULL;

	return ret;
}

static void cvm_ipv4_fwd_cleanup(void)
{
	cvm_ipv4_fwd = false;
	clear_ipv4_bit(ipfwd_flags);

	cvm_ipv4_pppoe = false;
	clear_pppoe_ipv4_bit(ipfwd_flags);

	cvm_ipv4_vlan = false;
	clear_vlan_ipv4_bit(ipfwd_flags);

	cvm_ipv4_gre = false;
	clear_gre_ipv4_bit(ipfwd_flags);

	cvm_ipv4_bonding = false;
	clear_bonding_ipv4_bit(ipfwd_flags);

	pr_info("Freeing IPv4 Forward cache\n");

	/* Free the IPv4 Forwarding cache (/proc readers may still be active) */
	mutex_lock(&cvm_ipfwd_table_mutex);
	if (cvm_gbl_ipv4_fwd_cache) {
		cvm_ipfwd_flush_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
		vfree((void *)cvm_gbl_ipv4_fwd_cache);
	}
	cvm_gbl_ipv4_fwd_cache = NULL;
	mutex_unlock(&cvm_ipfwd_table_mutex);

	pr_info("Removing IPv4 proc entries\n");

	/* Clean IPv4 proc entries */
	cvm_ipv4_clean_proc();
}

static void cvm_ipv6_clean_proc(void)
{
	if(!ipfwd_proc.ipv6.dir) {
		printk(KERN_INFO"/proc/cavium/ipv6 aready removed.\n");
		return;
	}

	/* Remove ipv6 entries /proc/cavium */
	if (ipfwd_proc.ipv6.cache)
		remove_proc_entry("cache", ipfwd_proc.ipv6.dir);
#ifdef IPFWD_IPV6_BONDING			
	if (ipfwd_proc.ipv6.bonding)
		remove_proc_entry("bonding", ipfwd_proc.ipv6.dir);	
#endif

#ifdef IPFWD_IPV6_PPPOE
	if (ipfwd_proc.ipv6.pppoe)
		remove_proc_entry("pppoe", ipfwd_proc.ipv6.dir);
#endif

	if (ipfwd_proc.ipv6.vlan)
		remove_proc_entry("vlan", ipfwd_proc.ipv6.dir);
	if (ipfwd_proc.ipv6.fwd)
		remove_proc_entry("fwd", ipfwd_proc.ipv6.dir);
	if (ipfwd_proc.ipv6.cache_size)
		remove_proc_entry("cache_size", ipfwd_proc.ipv6.dir);
	if (ipfwd_proc.ipv6.dir)
		remove_proc_entry("ipv6", ipfwd_proc.dir);
}

static int ipv6_fwd_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv6_fwd);

	return 0;
}

static int ipv6_fwd_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv6_fwd_show, NULL);
}

static ssize_t ipv6_fwd_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV6 forwarding %s\n", (val ? "Enabled" : "Disabled"));

	mutex_lock(&cvm_ipfwd_table_mutex);
	if (val) {
		if (!cvm_ipv6_fwd && !cvm_gbl_ipv6_fwd_cache) {
			cvm_ipfwd_flow_bucket_t *cache;

			cache = cvm_ipfwd_alloc_cache(ipv6_cache_size);
			if (!cache) {
				pr_err("IPv6 forwading cache table allocation failed (%lu entries), continuing with offloading disabled\n", val);
				goto err;
			}

			CVMX_SYNC;
			synchronize_net();	/* let fast-path readers finish before freeing */

			cvm_gbl_ipv6_fwd_cache = cache;
			cvm_ipfwd_init_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size);

			set_ipv6_bit(ipfwd_flags);
			cvm_ipv6_fwd = true;
			CVMX_SYNCW;
		}
	} else {
		if (cvm_ipv6_fwd && cvm_gbl_ipv6_fwd_cache) {
			cvm_ipv6_fwd = false;
			clear_ipv6_bit(ipfwd_flags);

			CVMX_SYNC;
			synchronize_net();	/* let fast-path readers finish before freeing */

			cvm_ipfwd_flush_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
			vfree((void *)cvm_gbl_ipv6_fwd_cache);
			cvm_gbl_ipv6_fwd_cache = NULL;

			CVMX_SYNCW;
		}
	}

err:
	mutex_unlock(&cvm_ipfwd_table_mutex);
	return size;
}

static const struct ipfwd_proc_ops ipv6_fwd_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv6_fwd_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv6_fwd_write,
};

#ifdef IPFWD_IPV6_PPPOE
static int ipv6_pppoe_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv6_pppoe);

	return 0;
}

static int ipv6_pppoe_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv6_pppoe_show, NULL);
}

static ssize_t ipv6_pppoe_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV6 PPPOE forwarding %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_pppoe_ipv6_bit(ipfwd_flags);
		cvm_ipv6_pppoe = true;
	} else {
		clear_pppoe_ipv6_bit(ipfwd_flags);
		cvm_ipv6_pppoe = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv6_pppoe_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv6_pppoe_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv6_pppoe_write,
};
#endif

static int ipv6_vlan_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv6_vlan);

	return 0;
}

static int ipv6_vlan_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv6_vlan_show, NULL);
}

static ssize_t ipv6_vlan_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV6 VLAN forwarding %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_vlan_ipv6_bit(ipfwd_flags);
		cvm_ipv6_vlan = true;
	} else {
		clear_vlan_ipv6_bit(ipfwd_flags);
		cvm_ipv6_vlan = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv6_vlan_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv6_vlan_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv6_vlan_write,
};

#ifdef IPFWD_IPV6_BONDING
static int ipv6_bonding_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_ipv6_bonding);

	return 0;
}

static int ipv6_bonding_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipv6_bonding_show, NULL);
}

static ssize_t ipv6_bonding_write(struct file *file, const char __user *input,
				size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;
	int err;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	err = kstrtoul(buffer, 0, &val);
	if (err < 0)
		return err;

	pr_info("IPV6 Bonding forwarding %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		set_bonding_ipv6_bit(ipfwd_flags);
		cvm_ipv6_bonding = true;
	} else {
		clear_bonding_ipv6_bit(ipfwd_flags);
		cvm_ipv6_bonding = false;
	}

	return size;
}

static const struct ipfwd_proc_ops ipv6_bonding_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipv6_bonding_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= ipv6_bonding_write,
};
#endif

static int cvm_ipv6_init_proc(void)
{
	int ret = 0;

#ifdef CONFIG_PROC_FS
	pr_info("\ncreating /proc/cavium/ipv6\n");
	/* create /proc/cavium/ipv6 directory */
	ipfwd_proc.ipv6.dir = proc_mkdir("ipv6", ipfwd_proc.dir);
	if (!ipfwd_proc.ipv6.dir) {
		pr_err("Failed to create /proc/cavium/ipv6 directory\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}

	/* create /proc/cavium/ipv6/fwd entry */
	ipfwd_proc.ipv6.fwd = proc_create_data("fwd", 0644, ipfwd_proc.ipv6.dir, &ipv6_fwd_proc_fops, NULL);
	if (!ipfwd_proc.ipv6.fwd) {
		pr_err("Failed to create /proc/cavium/ipv6/fwd\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv6/fwd\n");

#ifdef IPFWD_IPV6_PPPOE
	/* create /proc/cavium/ipv6/pppoe entry */
	ipfwd_proc.ipv6.pppoe = proc_create_data("pppoe", 0644, ipfwd_proc.ipv6.dir, &ipv6_pppoe_proc_fops, NULL);
	if (!ipfwd_proc.ipv6.pppoe) {
		pr_err("Failed to create /proc/cavium/ipv6/pppoe\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv6/pppoe\n");
#endif	
        /* create /proc/cavium/ipv6/vlan entry */
	ipfwd_proc.ipv6.vlan = proc_create_data("vlan", 0644, ipfwd_proc.ipv6.dir, &ipv6_vlan_proc_fops, NULL);
	if (!ipfwd_proc.ipv6.vlan) {
		pr_err("Failed to create /proc/cavium/ipv6/vlan\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv6/vlan\n");

#ifdef IPFWD_IPV6_BONDING
	/* create /proc/cavium/ipv6/bonding entry */
	ipfwd_proc.ipv6.bonding = proc_create_data("bonding", 0644, ipfwd_proc.ipv6.dir, &ipv6_bonding_proc_fops, NULL);
	if (!ipfwd_proc.ipv6.bonding) {
		pr_err("Failed to create /proc/cavium/ipv6/bonding\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv6/bonding\n");
#endif

	/* create /proc/cavium/ipv6/cache_size entry */
	ipfwd_proc.ipv6.cache_size = proc_create_data("cache_size", 0600, ipfwd_proc.ipv6.dir, &ipv6_cache_size_proc_fops, NULL);
	if (!ipfwd_proc.ipv6.cache_size) {
		pr_err("Failed to create /proc/cavium/ipv6/cache_size\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv6/cache_size\n");

	/* create /proc/cavium/ipv6/cache entry */
	ipfwd_proc.ipv6.cache = proc_create_data("cache", 0600, ipfwd_proc.ipv6.dir, &ipv6_cache_proc_fops, NULL);
	if (!ipfwd_proc.ipv6.cache) {
		pr_err("Failed to create /proc/cavium/ipv6/cache\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv6/cache\n");

	/* create /proc/cavium/ipv6/ignore_cache_flush entry */
	ipfwd_proc.ipv6.ignore_cache_flush = proc_create_data("ignore_cache_flush", 0600, ipfwd_proc.ipv6.dir, &ipv6_ignore_cache_flush_proc_fops, NULL);
	if (!ipfwd_proc.ipv6.cache) {
		pr_err("Failed to create /proc/cavium/ipv6/ignore_cache_flush\n");
		ret = -ENOMEM;
		goto ipv6_proc_failed;
	}
	pr_info("\t/proc/cavium/ipv6/ignore_cache_flush\n");

	return 0;

ipv6_proc_failed:
	cvm_ipv6_clean_proc();
#endif
	return ret;
}

int cvm_ipv6_fwd_init(void)
{
	int ret = 0;

	if (cvm_ipv6_pppoe && cvm_ipv6_vlan) {
		pr_err("Both PPPOE and VLAN offload at same time is not supported\n");
		return -EINVAL;
	}

	if (!ipv6_cache_size) {
		pr_err("Module param ipv6_cache_size must be non zero.Reseting it to %d.\n", CVM_IPV6FWD_LUT_DEFAULT);
		ipv6_cache_size = CVM_IPV6FWD_LUT_DEFAULT;
	} else if (ipv6_cache_size > CVM_IPV6FWD_LUT_MAX) {
		pr_err("Module param ipv6_cache_size must be less than %d.Reseting it to %d.\n", CVM_IPV6FWD_LUT_MAX + 1,
												 CVM_IPV6FWD_LUT_MAX);
		ipv6_cache_size = CVM_IPV6FWD_LUT_MAX;
	} else if (ipv6_cache_size & (ipv6_cache_size - 1)) {
		pr_err("Module param ipv6_cache_size must be power of 2.Reseting it to %d.\n", CVM_IPV6FWD_LUT_DEFAULT);
		ipv6_cache_size = CVM_IPV6FWD_LUT_DEFAULT;
	}

	if (cvm_ipv6_fwd) { /* Just in case the default is changed... */
		cvm_ipfwd_flow_bucket_t *cache;

		cache = cvm_ipfwd_alloc_cache(ipv6_cache_size);
		if (!cache) {
			pr_err("IPv6 forwading cache table allocation failed (%u entries)\n", ipv6_cache_size);
			goto ipv6_init_failed;
		}

		cvm_gbl_ipv6_fwd_cache = cache;
		cvm_ipfwd_init_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size);
	}

	pr_info("\nIPv6 Forwarding cache Initialization done.\n");

	/* Create IPv6 proc entries under /proc/cavium */
	ret = cvm_ipv6_init_proc();
	if (ret) {
		pr_err("IPv6 Forwarding init failed\n");
		goto ipv6_init_failed;
	}

	/* Enable IPv6 FWD features */
	if (cvm_ipv6_fwd)
		set_ipv6_bit(ipfwd_flags);
	if (cvm_ipv6_pppoe)
		set_pppoe_ipv6_bit(ipfwd_flags);
	if (cvm_ipv6_vlan)
		set_vlan_ipv6_bit(ipfwd_flags);
	if (cvm_ipv6_bonding)
		set_bonding_ipv6_bit(ipfwd_flags);

	return 0;

ipv6_init_failed:
	if (cvm_gbl_ipv6_fwd_cache)
		vfree((void *)cvm_gbl_ipv6_fwd_cache);
	cvm_gbl_ipv6_fwd_cache = NULL;

	return ret;
}

void cvm_ipv6_fwd_cleanup(void)
{
	cvm_ipv6_fwd = false;
	clear_ipv6_bit(ipfwd_flags);

	cvm_ipv6_pppoe = false;
	clear_pppoe_ipv6_bit(ipfwd_flags);

	cvm_ipv6_vlan = false;
	clear_vlan_ipv6_bit(ipfwd_flags);

	cvm_ipv6_bonding = false;
	clear_bonding_ipv6_bit(ipfwd_flags);

	pr_info("Freeing IPv6 Forward cache\n");

	/* Free the IPv6 Forwarding cache (/proc readers may still be active) */
	mutex_lock(&cvm_ipfwd_table_mutex);
	if (cvm_gbl_ipv6_fwd_cache) {
		cvm_ipfwd_flush_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
		vfree((void *)cvm_gbl_ipv6_fwd_cache);
	}
	cvm_gbl_ipv6_fwd_cache = NULL;
	mutex_unlock(&cvm_ipfwd_table_mutex);

	pr_info("Removing IPv6 proc entries\n");

	/* Clean IPv6 proc entries */
	cvm_ipv6_clean_proc();
}
/*
 * Invalidate offloaded flows when forwarding policy or routing changes.
 *
 * The engine only re-checks a cached flow occasionally (random slow-path
 * samples once it is "old", and expiry after NEW+OLD lifetime, 16 s at HZ=100),
 * so without this a newly added firewall rule could be bypassed for seconds.
 * Bumping cvm_gbl_ipfwd_cache_flush_stamp makes every existing entry look
 * expired at its next lookup.
 *
 * Triggers: the kernel's cvm_offload_invalidate() (nftables commit, iptables
 * table replace) when available, plus route, address and link changes.
 *
 * Two bumps: one immediately, and one after an RCU grace period. A packet that
 * was filtered by the old ruleset may still be on its way to the tx hook and
 * would cache its flow with the new stamp; after synchronize_net() no such
 * packet can remain. The 8-bit stamp wraps after 256 bumps, at which point
 * entries stamped 256 flushes ago would look valid again, so on wrap the work
 * item also wipes both caches (with offload paused around a grace period).
 */
static DEFINE_SPINLOCK(cvm_ipfwd_inval_lock);
static bool cvm_ipfwd_inval_wrapped;
static atomic_long_t cvm_ipfwd_invalidations = ATOMIC_LONG_INIT(0);

long cvm_ipfwd_invalidation_count(void)
{
	return atomic_long_read(&cvm_ipfwd_invalidations);
}

static void cvm_ipfwd_bump_stamp(void)
{
	unsigned long flags;

	spin_lock_irqsave(&cvm_ipfwd_inval_lock, flags);
	if (++cvm_gbl_ipfwd_cache_flush_stamp == 0)
		cvm_ipfwd_inval_wrapped = true;
	CVMX_SYNCW;
	spin_unlock_irqrestore(&cvm_ipfwd_inval_lock, flags);
}

static void cvm_ipfwd_inval_work_fn(struct work_struct *work)
{
	bool wrapped;
	unsigned long flags;

	synchronize_net();
	cvm_ipfwd_bump_stamp();

	spin_lock_irqsave(&cvm_ipfwd_inval_lock, flags);
	wrapped = cvm_ipfwd_inval_wrapped;
	cvm_ipfwd_inval_wrapped = false;
	spin_unlock_irqrestore(&cvm_ipfwd_inval_lock, flags);

	if (wrapped) {
		bool v4, v6;

		mutex_lock(&cvm_ipfwd_table_mutex);
		v4 = cvm_ipv4_fwd;
		v6 = cvm_ipv6_fwd;

		cvm_ipv4_fwd = false;
		cvm_ipv6_fwd = false;
		clear_ipv4_bit(ipfwd_flags);
		clear_ipv6_bit(ipfwd_flags);
		CVMX_SYNC;
		synchronize_net();	/* no fast-path reader left */
		if (cvm_gbl_ipv4_fwd_cache)
			cvm_ipfwd_flush_cache(cvm_gbl_ipv4_fwd_cache, ipv4_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
		if (cvm_gbl_ipv6_fwd_cache)
			cvm_ipfwd_flush_cache(cvm_gbl_ipv6_fwd_cache, ipv6_cache_size, CVM_IPFWD_ENTRIES_PER_BUCKET);
		cvm_ipv4_fwd = v4;
		cvm_ipv6_fwd = v6;
		if (v4)
			set_ipv4_bit(ipfwd_flags);
		if (v6)
			set_ipv6_bit(ipfwd_flags);
		CVMX_SYNCW;
		mutex_unlock(&cvm_ipfwd_table_mutex);
		incr_ipfwd_flow_stat(IPV4_FLUSHES);
	}
}
static DECLARE_WORK(cvm_ipfwd_inval_work, cvm_ipfwd_inval_work_fn);

/* Safe from any context. Also reachable from userspace via /proc/cavium/invalidate,
 * e.g. after deleting conntrack entries (no kernel hook fires for that; 5.15 allows
 * one conntrack event notifier and ctnetlink owns it).
 */
void cvm_ipfwd_invalidate(void)
{
	atomic_long_inc(&cvm_ipfwd_invalidations);
	cvm_ipfwd_bump_stamp();
	schedule_work(&cvm_ipfwd_inval_work);
}

static int cvm_ipfwd_netdev_event(struct notifier_block *nb, unsigned long event, void *ptr)
{
	switch (event) {
	case NETDEV_UP:
	case NETDEV_DOWN:
	case NETDEV_CHANGE:
	case NETDEV_CHANGEADDR:
	case NETDEV_CHANGEMTU:
	case NETDEV_CHANGEUPPER:
	case NETDEV_UNREGISTER:
		cvm_ipfwd_invalidate();
	}
	return NOTIFY_DONE;
}

static int cvm_ipfwd_addr_event(struct notifier_block *nb, unsigned long event, void *ptr)
{
	cvm_ipfwd_invalidate();
	return NOTIFY_DONE;
}

static int cvm_ipfwd_fib_event(struct notifier_block *nb, unsigned long event, void *ptr)
{
	cvm_ipfwd_invalidate();
	return NOTIFY_DONE;
}

/*
 * Neighbour (ARP/ND) changes. A cached flow carries its next hop's MAC in its
 * L2 header, so after that MAC changes the flow keeps sending to the old one
 * until it expires (~16 s). The kernel signals NETEVENT_NEIGH_UPDATE on every
 * neighbour state change, including the routine REACHABLE/STALE/DELAY cycle
 * each host goes through every few tens of seconds, so invalidating on each
 * would keep punting every flow. Instead remember the last MAC seen per
 * neighbour and invalidate only when it changes. The table is small and lossy:
 * a neighbour pushed out by a collision is re-learned on its next event, and a
 * MAC change missed that way waits for expiry as before.
 */
#define CVM_IPFWD_NEIGH_SLOTS	256

struct cvm_ipfwd_neigh_slot {
	int	ifindex;
	u8	family;
	u8	key[sizeof(struct in6_addr)];
	u8	ha[ETH_ALEN];
};

static struct cvm_ipfwd_neigh_slot cvm_ipfwd_neigh_slots[CVM_IPFWD_NEIGH_SLOTS];
static DEFINE_SPINLOCK(cvm_ipfwd_neigh_lock);

static int cvm_ipfwd_netevent(struct notifier_block *nb, unsigned long event, void *ptr)
{
	struct neighbour *n = ptr;
	struct cvm_ipfwd_neigh_slot *slot;
	unsigned int keylen = n->tbl->key_len;
	int family = n->tbl->family;
	u8 ha[ETH_ALEN];
	bool changed = false;
	unsigned long flags;

	if (event != NETEVENT_NEIGH_UPDATE)
		return NOTIFY_DONE;
	if ((family != AF_INET && family != AF_INET6) || keylen > sizeof(slot->key))
		return NOTIFY_DONE;
	if (n->dev->addr_len != ETH_ALEN || !(READ_ONCE(n->nud_state) & NUD_VALID))
		return NOTIFY_DONE;

	neigh_ha_snapshot(ha, n, n->dev);
	slot = &cvm_ipfwd_neigh_slots[jhash(n->primary_key, keylen, n->dev->ifindex) % CVM_IPFWD_NEIGH_SLOTS];

	spin_lock_irqsave(&cvm_ipfwd_neigh_lock, flags);
	if (slot->ifindex == n->dev->ifindex && slot->family == family &&
	    !memcmp(slot->key, n->primary_key, keylen)) {
		changed = memcmp(slot->ha, ha, ETH_ALEN) != 0;
	} else {
		slot->ifindex = n->dev->ifindex;
		slot->family = family;
		memcpy(slot->key, n->primary_key, keylen);
	}
	memcpy(slot->ha, ha, ETH_ALEN);
	spin_unlock_irqrestore(&cvm_ipfwd_neigh_lock, flags);

	if (changed) {
		if (family == AF_INET)
			pr_info_ratelimited("ipfwd: neighbour %pI4 on %s is now %pM, invalidating\n", n->primary_key, n->dev->name, ha);
		else
			pr_info_ratelimited("ipfwd: neighbour %pI6c on %s is now %pM, invalidating\n", n->primary_key, n->dev->name, ha);
		cvm_ipfwd_invalidate();
	}
	return NOTIFY_DONE;
}

static struct notifier_block cvm_ipfwd_netdev_nb = { .notifier_call = cvm_ipfwd_netdev_event };
static struct notifier_block cvm_ipfwd_netevent_nb = { .notifier_call = cvm_ipfwd_netevent };
static struct notifier_block cvm_ipfwd_inetaddr_nb = { .notifier_call = cvm_ipfwd_addr_event };
static struct notifier_block cvm_ipfwd_inet6addr_nb = { .notifier_call = cvm_ipfwd_addr_event };
static struct notifier_block cvm_ipfwd_fib_nb = { .notifier_call = cvm_ipfwd_fib_event };

static int cvm_ipfwd_invalidate_init(void)
{
	int ret;

	ret = register_netdevice_notifier(&cvm_ipfwd_netdev_nb);
	if (ret)
		return ret;
	register_inetaddr_notifier(&cvm_ipfwd_inetaddr_nb);
	register_inet6addr_notifier(&cvm_ipfwd_inet6addr_nb);
	register_netevent_notifier(&cvm_ipfwd_netevent_nb);
	ret = register_fib_notifier(&init_net, &cvm_ipfwd_fib_nb, NULL, NULL);
	if (ret)
		pr_warn("ipfwd: no FIB notifier (%d); route changes rely on flow expiry\n", ret);
#ifdef CVM_IPFWD_HAVE_FLUSH_HOOK
	WRITE_ONCE(cvm_ipfwd_flush_hook, cvm_ipfwd_invalidate);
#else
	pr_warn("ipfwd: kernel has no offload flush hook; firewall changes rely on flow expiry\n");
#endif
	return 0;
}

static void cvm_ipfwd_invalidate_exit(void)
{
#ifdef CVM_IPFWD_HAVE_FLUSH_HOOK
	WRITE_ONCE(cvm_ipfwd_flush_hook, NULL);
#endif
	unregister_fib_notifier(&init_net, &cvm_ipfwd_fib_nb);
	unregister_netevent_notifier(&cvm_ipfwd_netevent_nb);
	unregister_inet6addr_notifier(&cvm_ipfwd_inet6addr_nb);
	unregister_inetaddr_notifier(&cvm_ipfwd_inetaddr_nb);
	unregister_netdevice_notifier(&cvm_ipfwd_netdev_nb);
	synchronize_net();
	flush_work(&cvm_ipfwd_inval_work);
}

/*
 * /proc/cavium/flows: the live (unexpired) offloaded flows, IPv4 then IPv6, one
 * text line each, for the web UI's "is this flow offloaded?" view. Read-only and
 * side-effect free (unlike cavium/ipv4/flows, whose reads zero the counters):
 *   family proto in_dev out_dev src sport dst dport tx_src tx_sport tx_dst tx_dport vlan age_ms
 * The tx_* tuple is the packet as sent (after NAT). The table mutex is held from
 * start to stop, as in export.c.
 */
static void *flows_seq_start(struct seq_file *s, loff_t *pos)
{
	mutex_lock(&cvm_ipfwd_table_mutex);
	if (*pos >= (loff_t)ipv4_cache_size + ipv6_cache_size)
		return NULL;
	return pos;
}

static void *flows_seq_next(struct seq_file *s, void *v, loff_t *pos)
{
	if (++*pos >= (loff_t)ipv4_cache_size + ipv6_cache_size)
		return NULL;
	return pos;
}

static void flows_seq_stop(struct seq_file *s, void *v)
{
	mutex_unlock(&cvm_ipfwd_table_mutex);
}

static int flows_seq_show(struct seq_file *s, void *v)
{
	loff_t n = *(loff_t *)v;
	bool ip6 = n >= ipv4_cache_size;
	cvm_ipfwd_flow_bucket_t *cache = ip6 ? cvm_gbl_ipv6_fwd_cache : cvm_gbl_ipv4_fwd_cache;
	cvm_ipfwd_flow_bucket_t *bucket;
	cvm_ipfwd_flow_entry_t e[CVM_IPFWD_ENTRIES_PER_BUCKET];
	unsigned long flags;
	u32 now = CVM_IPFWD_TIMER_GET_TIME;
	int i;

	if (ip6) {
		n -= ipv4_cache_size;
		if (!cvm_ipv6_fwd)
			return 0;
	} else if (!cvm_ipv4_fwd)
		return 0;
	if (!cache)
		return 0;

	bucket = &cache[n];
	spin_lock_irqsave(&bucket->hdr.wr_lock, flags);	/* writers hold it: the entries are stable */
	memcpy(e, bucket->entry, sizeof(e));
	spin_unlock_irqrestore(&bucket->hdr.wr_lock, flags);

	rcu_read_lock();	/* flow_info is freed after a grace period */
	for (i = 0; i < CVM_IPFWD_ENTRIES_PER_BUCKET; i++) {
		cvm_ipfwd_flow_info_t *fi;
		struct net_device *in;
		u32 ports;

		if (!e[i].s.flow_info || !e[i].s.id0 || e[i].s.id0 != e[i].s.id1)
			continue;
		if (cvm_ipfwd_check_timestamp(e[i].s.timestamp, e[i].s.cache_flush_stamp) == CVM_IPFWD_EXPIRED)
			continue;
		fi = phys_to_virt(e[i].s.flow_info << 2);
		in = dev_get_by_index_rcu(&init_net, fi->rx_ifindex);
		ports = ntohl(fi->ports);
		/* the key's port names are swapped: setup_*_flow_cache stores the source port in
		 * l4_dport and the destination port in l4_sport (export.c keeps that quirk) */
		seq_printf(s, "%d %u %s %s ", ip6 ? 6 : 4, e[i].s.ip_proto,
			   in ? in->name : "-", fi->dev ? fi->dev->name : "-");
		if (ip6) {
			u64 a[2], b[2], c[2], d[2];

			a[0] = e[i].s.ip_saddrhi; a[1] = e[i].s.ip_saddrlo;
			b[0] = e[i].s.ip_daddrhi; b[1] = e[i].s.ip_daddrlo;
			c[0] = fi->ip_saddrhi;    c[1] = fi->ip_saddrlo;
			d[0] = fi->ip_daddrhi;    d[1] = fi->ip_daddrlo;
			seq_printf(s, "%pI6c %u %pI6c %u %pI6c %u %pI6c %u",
				   a, ntohs(e[i].s.l4_dport), b, ntohs(e[i].s.l4_sport),
				   c, ports >> 16, d, ports & 0xffff);
		} else {
			seq_printf(s, "%pI4 %u %pI4 %u %pI4 %u %pI4 %u",
				   &e[i].s.ip_saddr, ntohs(e[i].s.l4_dport), &e[i].s.ip_daddr, ntohs(e[i].s.l4_sport),
				   &fi->ip_saddr, ports >> 16, &fi->ip_daddr, ports & 0xffff);
		}
		seq_printf(s, " %u %u\n", e[i].s.vlan_id,
			   jiffies_to_msecs((now - (u32)e[i].s.timestamp) & CMV_IPFWD_TIMER_MAX));
	}
	rcu_read_unlock();
	return 0;
}

static const struct seq_operations flows_seq_ops = {
	.start = flows_seq_start,
	.next  = flows_seq_next,
	.stop  = flows_seq_stop,
	.show  = flows_seq_show
};

static int flows_open(struct inode *inode, struct file *file)
{
	return seq_open(file, &flows_seq_ops);
}

static const struct ipfwd_proc_ops flows_file_ops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN    = flows_open,
	IPFWD_PROC_READ    = seq_read,
	IPFWD_PROC_LSEEK   = seq_lseek,
	IPFWD_PROC_RELEASE = seq_release
};

static int __init ipfwd_init(void)
{
	int ret = 0, idx;
	struct net_device *dev = NULL;

	pr_info("%s - version %s\n", ipfwd_string, ipfwd_version);

	/* setup common proc entries */
	ret = cvm_init_common_proc();
	if (ret) {
		pr_err("Failed to create common proc entries\n");
		goto ipfwd_init_failed;
	}

#if IPFWD_ENABLE_FILTER
	/* setup filter cache */
	ret = cvm_ipfwd_filter_init();
	if (ret) {
		pr_err("Failed to init IP Filter cache\n");
		goto ipfwd_init_failed;
	}
#endif

	/* IPv4 init */
	ret = cvm_ipv4_fwd_init();
	if (ret) {
		pr_err("Failed to init IPv4 Fwd cache\n");
		goto ipfwd_init_failed;
	}

	/* IPv6 init */
	ret = cvm_ipv6_fwd_init();
	if (ret) {
		pr_err("Failed to init IPv4 Fwd cache\n");
		goto ipfwd_init_failed;
	}

	// This sanity check will trigger error if flow-bucket is not cache-aligned
	if (sizeof(cvm_ipfwd_flow_bucket_t) != CVMX_CACHE_LINE_SIZE) {
		printk("   *****************************************************\n");
		printk("   * ERROR - size of flow bucket is not cache-aligned: *\n");
		printk("   *   cache-line-size  = %04d                         *\n", CVMX_CACHE_LINE_SIZE);
		printk("   *   bucket-size = %04lu                             *\n", sizeof(cvm_ipfwd_flow_bucket_t));
		printk("   *****************************************************\n");
	}

#if IPFWD_ENABLE_QOS
	/* config input qos */
	ret = ipfwd_input_qos_init();
	if (ret) {
		pr_err("Failed to config input qos\n");
		goto ipfwd_init_failed;
	}

	/* config output qos */
	ret = ipfwd_output_qos_init();
	if (ret) {
		pr_err("Failed to config output qos\n");
		goto ipfwd_init_failed;
	}
#endif

	cvm_gbl_ipfwd_cache_flush_stamp = 0;

	/* Register callback-function for each octeon interface */
	for (idx = 1; (dev = dev_get_by_index(&init_net, idx)); idx++) {
		platform_register_pkt_callback(dev->name, pkt_receive_cb);
		dev_put(dev);
	}

	cvm_ipfwd_rx_hook = pkt_receive;
	cvm_ipfwd_tx_hook = pkt_cache;

	ret = cvm_ipfwd_invalidate_init();
	if (ret) {
		pr_err("Failed to register invalidation notifiers\n");
		goto ipfwd_init_failed;
	}

#ifdef CVM_QOS_POLICER
	cvm_qos_policer_init();
#endif

#ifdef CVM_IPFWD_MQUEUES_SUPPORT
	cvm_ipfwd_mq_init();
#endif
#ifdef FLOW_COUNTERS
        if (export_init() != 0)
            goto ipfwd_init_failed;
#endif
	if (!proc_create("cavium/flows", 0600, NULL, &flows_file_ops))
		pr_warn("Failed to create /proc/cavium/flows\n");	/* UI view only, not fatal */

	return 0;

ipfwd_init_failed:
	cvm_ipv4_fwd_cleanup();

	cvm_ipv6_fwd_cleanup();

#if IPFWD_ENABLE_FILTER
	cvm_ipfwd_filter_cleanup();
#endif

#if IPFWD_ENABLE_QOS
	ipfwd_input_qos_exit();

	ipfwd_output_qos_exit();
#endif

	cvm_clean_common_proc();

	return ret;
}

static void __exit ipfwd_exit(void)
{
	int idx;
	struct net_device *dev = NULL;

	cvm_ipfwd_invalidate_exit();

	ipfwd_flags = 0;
	CVMX_SYNC;

#ifdef FLOW_COUNTERS
        export_exit();
#endif
	remove_proc_entry("cavium/flows", NULL);

	cvm_ipfwd_rx_hook = NULL;
	cvm_ipfwd_tx_hook = NULL;

	/* Unregister callback-function for each octeon interface */
	for (idx = 1; (dev = dev_get_by_index(&init_net, idx)); idx++) {
		platform_register_pkt_callback(dev->name, NULL);
		dev_put(dev);
	}

	CVMX_SYNC;

	/* Clean IPv4 stuff */
	cvm_ipv4_fwd_cleanup();

	/* Clean IPv6 stuff */
	cvm_ipv6_fwd_cleanup();

#if IPFWD_ENABLE_FILTER
	/* Clean Filter stuff */
	cvm_ipfwd_filter_cleanup();
#endif

#if IPFWD_ENABLE_QOS
	/* clean input qos stuff */
	ipfwd_input_qos_exit();

	/* clean output qos stuff */
	ipfwd_output_qos_exit();
#endif

	/* Clean common proc entries */
	cvm_clean_common_proc();

#ifdef CVM_QOS_POLICER
	cvm_qos_policer_deinit();
#endif

#ifdef CVM_IPFWD_MQUEUES_SUPPORT
	cvm_ipfwd_mq_exit();
#endif

}

module_init(ipfwd_init);
module_exit(ipfwd_exit);
