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

#include <linux/module.h>
#include <linux/moduleparam.h>
#include <linux/slab.h>
#include <linux/kernel.h>
#include <linux/seq_file.h>
#include <linux/proc_fs.h>

#include <asm/uaccess.h>

#include "ipfwd_compat.h"
#include "ipfwd_common.h"
#include "ipfwd_proc.h"

u64 CVM_IPFWD_TIMER_NEW_LIFETIME = 1200;
u64 CVM_IPFWD_TIMER_OLD_LIFETIME = 400;

struct ipfwd_proc_info ipfwd_proc;

/* info about offloaded features */
unsigned long ipfwd_flags = 0;

void dump_buffer(const void *buf, size_t len)
{
	print_hex_dump(KERN_INFO, " ", DUMP_PREFIX_NONE, 16, 2, buf, len, false);
}

void dump_buffer_str(const char *str, const void *buf, size_t len)
{
	pr_info("\n%s (%zu bytes)\n", str, len);

	print_hex_dump(KERN_INFO, " ", DUMP_PREFIX_NONE, 16, 2, buf, len, false);
}

#ifdef CONFIG_PROC_FS
int ipfwd_add_proc_entries(struct proc_dir_entry *dir, ipfwd_proc_entry_t *ent, void *data)
{
	struct proc_dir_entry *p;

	if (!dir || !ent)
		return 1;

	//pr_info("creating proc entries under %s\n", dir->name);

	while (ent->name) {
		p = proc_create_data(ent->name, ent->mode, dir, ent->proc_fops, data);		
		if (!p)
			return 1;

		pr_info("\t%s\n", ent->name);

		ent++;
	}

	return 0;
}

void ipfwd_remove_proc_entries(struct proc_dir_entry *dir, ipfwd_proc_entry_t *ent)
{
	if (!dir || !ent)
		return;

	//pr_info("removing proc entries under %s\n", dir->name);

	while (ent->name) {
		pr_info("\t%s\n", ent->name);
		remove_proc_entry(ent->name, dir);
		ent++;
	}
}

static int ipfwd_show(struct seq_file *s, void *v)
{
#ifdef DEBUG
	seq_printf(s, "IP offload Information\n");
	seq_printf(s, "==========================\n");
	seq_printf(s, "IPv4:		(%s)\n", test_bit(CVM_IPV4_BIT, &ipfwd_flags) ? "on" : "off");
#ifdef IPFWD_IPV4_PPPOE	
	seq_printf(s, "PPPOE IPv4:	(%s)\n", test_bit(CVM_IPV4_PPPOE_BIT, &ipfwd_flags) ? "on" : "off");
#endif
	seq_printf(s, "VLAN IPv4:	(%s)\n", test_bit(CVM_IPV4_VLAN_BIT, &ipfwd_flags) ? "on" : "off");
	seq_printf(s, "GRE IPv4:	(%s)\n", test_bit(CVM_IPV4_GRE_BIT, &ipfwd_flags) ? "on" : "off");
#ifdef IPFWD_IPV4_BONDING
	seq_printf(s, "BONDING IPv4:	(%s)\n", test_bit(CVM_IPV4_BONDING_BIT, &ipfwd_flags) ? "on" : "off");
#endif	
	seq_printf(s, "IPv6:		(%s)\n", test_bit(CVM_IPV6_BIT, &ipfwd_flags) ? "on" : "off");
#ifdef IPFWD_IPV6_PPPOE	
	seq_printf(s, "PPPOE IPv6:	(%s)\n", test_bit(CVM_IPV6_PPPOE_BIT, &ipfwd_flags) ? "on" : "off");
#endif
	seq_printf(s, "VLAN IPv6:	(%s)\n", test_bit(CVM_IPV6_VLAN_BIT, &ipfwd_flags) ? "on" : "off");
#ifdef IPFWD_IPV6_BONDING
	seq_printf(s, "BONDING IPv6:	(%s)\n", test_bit(CVM_IPV6_BONDING_BIT, &ipfwd_flags) ? "on" : "off");
#endif	

	seq_printf(s, "INPUT QOS:	(%s)\n", test_bit(CVM_INPUT_QOS_BIT, &ipfwd_flags) ? "on" : "off");
	
	seq_printf(s, "\n");
#endif

	return 0;
}

static int ipfwd_proc_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipfwd_show, NULL);
}

static const struct ipfwd_proc_ops common_fwd_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipfwd_proc_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
};

#if IPFWD_ENABLE_STATS
struct ipfwd_stats_info {
	struct ipfwd_counter	rx;
	struct ipfwd_counter	tx;
	struct ipfwd_counter	bypass;
	struct ipfwd_counter	bad_csum;
	struct ipfwd_counter	ipv4_rx;
	struct ipfwd_counter	ipv4_tx;
	struct ipfwd_counter	ipv6_rx;
	struct ipfwd_counter	ipv6_tx;
	struct ipfwd_counter	pppoe_rx;
	struct ipfwd_counter	pppoe_tx;
	struct ipfwd_counter	vlan_rx;
	struct ipfwd_counter	vlan_tx;

	atomic_long_t		flow_stats[IPFWD_FLOW_STATS_SIZE];
};

struct ipfwd_stats_info ipfwd_stats;
bool stats_collection = false;

static void init_ipfwd_stats(void)
{
	memset(&ipfwd_stats, 0, sizeof(struct ipfwd_stats_info));
}

void update_ipfwd_stats(u16 in_flow, u16 out_flow, int return_status, bool bad_checksum,
		unsigned long in_bytes, unsigned long out_bytes)
{
	struct ipfwd_counter *cnt = NULL;

	if (!stats_collection)
		return;

	cnt = &ipfwd_stats.rx;

	atomic_long_inc(&cnt->packets);
	atomic_long_add(in_bytes, &cnt->bytes);

	if(bad_checksum) {
		atomic_long_inc(&ipfwd_stats.bad_csum.packets);
		atomic_long_add(out_bytes, &ipfwd_stats.bad_csum.bytes);
	}

	switch (return_status) {
	case CVM_IPFWD_RET_FAILED:
		cnt = &ipfwd_stats.bypass;
		break;
	case CVM_IPFWD_RET_SUCCESS_FAST:
	case CVM_IPFWD_RET_SUCCESS_SLOW:
		cnt = &ipfwd_stats.tx;
		break;
	default:
		cnt = NULL;
		break;
	}

	if (cnt) {
		atomic_long_inc(&cnt->packets);
		atomic_long_add(out_bytes, &cnt->bytes);
	}

	switch (in_flow) {
	case ETH_P_IP:
		cnt = &ipfwd_stats.ipv4_rx;
		break;
	case ETH_P_IPV6:
		cnt = &ipfwd_stats.ipv6_rx;
		break;
	case ETH_P_PPP_SES:
		cnt = &ipfwd_stats.pppoe_rx;
		break;
	case ETH_P_8021Q:
		cnt = &ipfwd_stats.vlan_rx;
		break;
	default:
		cnt = NULL;
		break;
	}

	if (cnt) {
		atomic_long_inc(&cnt->packets);
		atomic_long_add(in_bytes, &cnt->bytes);
	}

	switch (out_flow) {
	case ETH_P_IP:
		cnt = &ipfwd_stats.ipv4_tx;
		break;
	case ETH_P_IPV6:
		cnt = &ipfwd_stats.ipv6_tx;
		break;
	case ETH_P_PPP_SES:
		cnt = &ipfwd_stats.pppoe_tx;
		break;
	case ETH_P_8021Q:
		cnt = &ipfwd_stats.vlan_tx;
		break;
	default:
		cnt = NULL;
		break;
	}

	if (cnt) {
		atomic_long_inc(&cnt->packets);
		atomic_long_add(out_bytes, &cnt->bytes);
	}
}

void incr_ipfwd_flow_stat(enum ipfwd_flow_stats counter)
{
	if (!stats_collection)
		return;

	atomic_long_inc(&ipfwd_stats.flow_stats[counter]);
}

static int ipfwd_stats_show(struct seq_file *s, void *v)
{
	if (!stats_collection)
		return 0;

	seq_printf(s, "\n");
	seq_printf(s, " Statistics\n");
	seq_printf(s, "========================\n");
	seq_printf(s, "\n");
	seq_printf(s, "RX packets:	%20lu\tbytes:	%20lu\n",
			atomic_long_read(&ipfwd_stats.rx.packets),
			atomic_long_read(&ipfwd_stats.rx.bytes));
	seq_printf(s, "TX packets:	%20lu\tbytes:	%20lu\n",
			atomic_long_read(&ipfwd_stats.tx.packets),
			atomic_long_read(&ipfwd_stats.tx.bytes));
	seq_printf(s, "Bypass packets:	%20lu\tbytes:	%20lu\n",
			atomic_long_read(&ipfwd_stats.bypass.packets),
			atomic_long_read(&ipfwd_stats.bypass.bytes));
	seq_printf(s, "Bad L4 checksum:%20lu\tbytes:	%20lu\n",
			atomic_long_read(&ipfwd_stats.bad_csum.packets),
			atomic_long_read(&ipfwd_stats.bad_csum.bytes));

	seq_printf(s, "\n");
	seq_printf(s, "Protocol\tRX packets\tRX bytes\t\tTX packets\tTX bytes\n");
	seq_printf(s, "\n");

	seq_printf(s, "ipv4\t\t%lu%18lu%20lu%18lu\n",
			atomic_long_read(&ipfwd_stats.ipv4_rx.packets),
			atomic_long_read(&ipfwd_stats.ipv4_rx.bytes),
			atomic_long_read(&ipfwd_stats.ipv4_tx.packets),
			atomic_long_read(&ipfwd_stats.ipv4_tx.bytes));

	seq_printf(s, "ipv6\t\t%lu%18lu%20lu%18lu\n",
			atomic_long_read(&ipfwd_stats.ipv6_rx.packets),
			atomic_long_read(&ipfwd_stats.ipv6_rx.bytes),
			atomic_long_read(&ipfwd_stats.ipv6_tx.packets),
			atomic_long_read(&ipfwd_stats.ipv6_tx.bytes));

	seq_printf(s, "pppoe\t\t%lu%18lu%20lu%18lu\n",
			atomic_long_read(&ipfwd_stats.pppoe_rx.packets),
			atomic_long_read(&ipfwd_stats.pppoe_rx.bytes),
			atomic_long_read(&ipfwd_stats.pppoe_tx.packets),
			atomic_long_read(&ipfwd_stats.pppoe_tx.bytes));

	seq_printf(s, "vlan\t\t%lu%18lu%20lu%18lu\n",
			atomic_long_read(&ipfwd_stats.vlan_rx.packets),
			atomic_long_read(&ipfwd_stats.vlan_rx.bytes),
			atomic_long_read(&ipfwd_stats.vlan_tx.packets),
			atomic_long_read(&ipfwd_stats.vlan_tx.bytes));

	seq_printf(s, "\n");

	seq_printf(s, " Forwarding cache size (IPv4)\n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "table_size (buckets)                  %u\n", ipv4_cache_size);
	seq_printf(s, "table size (bytes)                    %lu\n", sizeof(cvm_ipfwd_flow_bucket_t) * ipv4_cache_size);
	seq_printf(s, "flows_max (bytes)                     %lu\n", ipv4_cache_size * CVM_IPFWD_ENTRIES_PER_BUCKET * sizeof(cvm_ipfwd_flow_info_t));
	seq_printf(s, "\n");

	seq_printf(s, "\n");
	seq_printf(s, " Flow cache table size (IPv6)\n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "table_size (buckets)                  %u\n", ipv6_cache_size);
	seq_printf(s, "table size (bytes)                    %lu\n", sizeof(cvm_ipfwd_flow_bucket_t) * ipv6_cache_size);
	seq_printf(s, "flows_max (bytes)                     %lu\n", ipv6_cache_size * CVM_IPFWD_ENTRIES_PER_BUCKET * sizeof(cvm_ipfwd_flow_info_t));
	seq_printf(s, "\n");

	seq_printf(s, "\n");

	seq_printf(s, "\n");
	seq_printf(s, " Flow timers \n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "cycles                                %llu\n", cvmx_get_cycle());
	seq_printf(s, "clock_rate                            %llu\n", octeon_get_clock_rate());
	seq_printf(s, "HZ                                    %d\n", HZ);
	seq_printf(s, "timer_ticks                           %lu\n", CVM_IPFWD_TIMER_GET_TIME);
	seq_printf(s, "new_flow_interval (timer_ticks)       %llu\n", CVM_IPFWD_TIMER_NEW_LIFETIME);
	seq_printf(s, "old_flow_interval (timer_ticks)       %llu\n", CVM_IPFWD_TIMER_OLD_LIFETIME);
	seq_printf(s, "\n");

	seq_printf(s, "\n");
	seq_printf(s, " Low-level IPv4 flow dynamics\n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "ipv4_flow_found                       %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_FLOW_FOUND]));
	seq_printf(s, "    ipv4_flow_found_expired           %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_FLOW_FOUND_EXPIRED]));
	seq_printf(s, "    ipv4_flow_found_old_random_bypass %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_FLOW_FOUND_OLD_RANDOM_BYPASS]));
	seq_printf(s, "    ipv4_flow_found_action_bypass     %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_FLOW_FOUND_ACTION_BYPASS]));
	seq_printf(s, "\n");
	seq_printf(s, "ipv4_flow_not_found                   %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_FLOW_NOT_FOUND]));
	seq_printf(s, "\n");

	seq_printf(s, "\n");
	seq_printf(s, " IPv4 flow creation dynamcis\n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "ipv4_create_flow_found                            %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_CREATE_FLOW_FOUND]));
	seq_printf(s, "ipv4_create_flow_found_replaced                   %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_CREATE_FLOW_FOUND_REPLACED]));
	seq_printf(s, "ipv4_create_flow_not_found                        %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_CREATE_FLOW_NOT_FOUND]));
	seq_printf(s, "ipv4_create_flow_not_found_just_created           %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_CREATE_FLOW_NOT_FOUND_JUST_CREATED]));
	seq_printf(s, "ipv4_create_flow_not_found_replaced_expired       %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_CREATE_FLOW_NOT_FOUND_REPLACED_EXPIRED]));
	seq_printf(s, "ipv4_create_flow_not_found_replaced_non_expired   %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_CREATE_FLOW_NOT_FOUND_REPLACED_NON_EXPIRED]));
	seq_printf(s, "\n");

	seq_printf(s, "\n");
	seq_printf(s, " Low-level IPv6 flow dynamics\n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "ipv6_flow_found                       %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_FLOW_FOUND]));
	seq_printf(s, "    ipv6_flow_found_expired           %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_FLOW_FOUND_EXPIRED]));
	seq_printf(s, "    ipv6_flow_found_old_random_bypass %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_FLOW_FOUND_OLD_RANDOM_BYPASS]));
	seq_printf(s, "    ipv6_flow_found_action_bypass     %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_FLOW_FOUND_ACTION_BYPASS]));
	seq_printf(s, "\n");
	seq_printf(s, "ipv6_flow_not_found                   %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_FLOW_NOT_FOUND]));
	seq_printf(s, "\n");

	seq_printf(s, "\n");
	seq_printf(s, " IPv6 flow creation dynamics\n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "ipv6_create_flow_found                            %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_CREATE_FLOW_FOUND]));
	seq_printf(s, "ipv6_create_flow_found_replaced                   %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_CREATE_FLOW_FOUND_REPLACED]));
	seq_printf(s, "ipv6_create_flow_not_found                        %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_CREATE_FLOW_NOT_FOUND]));
	seq_printf(s, "ipv6_create_flow_not_found_just_created           %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_CREATE_FLOW_NOT_FOUND_JUST_CREATED]));
	seq_printf(s, "ipv6_create_flow_not_found_replaced_expired       %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_CREATE_FLOW_NOT_FOUND_REPLACED_EXPIRED]));
	seq_printf(s, "ipv6_create_flow_not_found_replaced_non_expired   %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_CREATE_FLOW_NOT_FOUND_REPLACED_NON_EXPIRED]));
	seq_printf(s, "\n");

	seq_printf(s, "\n");
	seq_printf(s, " Flow cache flushes\n");
	seq_printf(s, "=============================\n");
	seq_printf(s, "\n");
	seq_printf(s, "ipv4_flushes                          %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV4_FLUSHES]));
	seq_printf(s, "ipv6_flushes                          %lu\n", atomic_long_read(&ipfwd_stats.flow_stats[IPV6_FLUSHES]));
	seq_printf(s, "\n");

	return 0;
}

static ssize_t ipfwd_stats_proc_write(struct file *file, const char __user *input,
				      size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	val = simple_strtoul(buffer, NULL, 10);
	if (!val) {
		pr_info("clearning ip forwarding statistics\n");
		init_ipfwd_stats();
		stats_collection = false;
	} else {
		pr_info("starting ip forwarding statistics collection\n");
		stats_collection = true;
	}

	return size;
}

static int ipfwd_stats_proc_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipfwd_stats_show, NULL);
}

static const struct ipfwd_proc_ops common_stats_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipfwd_stats_proc_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_WRITE		= ipfwd_stats_proc_write,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
};
#endif /* IPFWD_ENABLE_STATS */

static ssize_t ipfwd_new_lifetime_proc_write(struct file *file, const char __user *input,
				      size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	val = simple_strtoul(buffer, NULL, 10);
	CVM_IPFWD_TIMER_NEW_LIFETIME = val;

	return size;
}

static int ipfwd_new_lifetime_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%llu\n", CVM_IPFWD_TIMER_NEW_LIFETIME);
	return 0;
}

static int ipfwd_new_lifetime_proc_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipfwd_new_lifetime_show, NULL);
}

static ssize_t ipfwd_old_lifetime_proc_write(struct file *file, const char __user *input,
				      size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	val = simple_strtoul(buffer, NULL, 10);
	CVM_IPFWD_TIMER_OLD_LIFETIME = val;

	return size;
}

static int ipfwd_old_lifetime_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%llu\n", CVM_IPFWD_TIMER_OLD_LIFETIME);
	return 0;
}

static int ipfwd_old_lifetime_proc_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipfwd_old_lifetime_show, NULL);
}

static const struct ipfwd_proc_ops common_new_lifetime_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipfwd_new_lifetime_proc_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_WRITE		= ipfwd_new_lifetime_proc_write,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
};

static const struct ipfwd_proc_ops common_old_lifetime_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipfwd_old_lifetime_proc_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_WRITE		= ipfwd_old_lifetime_proc_write,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
};

/* /proc/cavium/invalidate: write anything to invalidate every cached flow;
 * read the number of invalidations so far.
 */
static int ipfwd_invalidate_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%ld\n", cvm_ipfwd_invalidation_count());
	return 0;
}

static int ipfwd_invalidate_proc_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipfwd_invalidate_show, NULL);
}

static ssize_t ipfwd_invalidate_proc_write(struct file *file, const char __user *input,
					   size_t size, loff_t *ofs)
{
	cvm_ipfwd_invalidate();
	return size;
}

static const struct ipfwd_proc_ops common_invalidate_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipfwd_invalidate_proc_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_WRITE	= ipfwd_invalidate_proc_write,
	IPFWD_PROC_LSEEK	= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
};

#ifdef CVM_IPFWD_MQUEUES_SUPPORT

extern int cvm_mq_en;

static int ipfwd_cvm_mq_show(struct seq_file *s, void *v)
{
	seq_printf(s, "cvm_mq_en = %d\n", cvm_mq_en);
	return 0;
}

static int ipfwd_cvm_mq_open(struct inode *inode, struct file *file)
{
	return single_open(file, ipfwd_cvm_mq_show, NULL);
}

static ssize_t ipfwd_cvm_mq_write(struct file *file, const char __user *input,
				      size_t size, loff_t *ofs)
{
	char buffer[10];
	unsigned long val;

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = 0;

	val = simple_strtoul(buffer, NULL, 10);

	if (val)
		cvm_mq_en = 1;
	else
		cvm_mq_en = 0;

	return size;
}

static const struct ipfwd_proc_ops ipfwd_cvm_mq_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= ipfwd_cvm_mq_open,
	IPFWD_PROC_READ		= seq_read,
        IPFWD_PROC_WRITE          = ipfwd_cvm_mq_write,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
};

#endif

static ipfwd_proc_entry_t common_proc_entries[] = {
#ifdef DEBUG
	{ "fwd", S_IFREG | S_IRUSR, &common_fwd_proc_fops },
#endif
#if IPFWD_ENABLE_STATS
	{ "stats", S_IFREG | S_IRUSR, &common_stats_proc_fops },
#endif
#ifdef CVM_IPFWD_MQUEUES_SUPPORT
	{ "cvm_mq", S_IFREG | S_IRUSR | S_IWUSR, &ipfwd_cvm_mq_fops},
#endif
	{ "flow_new_lifetime", S_IFREG | S_IRUSR, &common_new_lifetime_proc_fops },
	{ "flow_old_lifetime", S_IFREG | S_IRUSR, &common_old_lifetime_proc_fops },
	{ "invalidate", S_IFREG | S_IRUSR | S_IWUSR, &common_invalidate_proc_fops },
	{}
};

#endif /* CONFIG_PROC_FS */

void cvm_clean_common_proc(void)
{
	pr_info("Removing common proc entries\n");

	ipfwd_remove_proc_entries(ipfwd_proc.dir, common_proc_entries);

#ifdef CONFIG_PROC_FS
	if (ipfwd_proc.dir)
		remove_proc_entry("cavium", NULL);
#endif
}

int cvm_init_common_proc(void)
{
	int ret = 0;

#ifdef CONFIG_PROC_FS
	pr_info("creating /proc/cavium\n");

	/* create /proc/cavium directory */
	ipfwd_proc.dir = proc_mkdir("cavium", NULL);
	if (!ipfwd_proc.dir) {
		pr_err("Failed to create /proc/cavium directory\n");
		return -ENOMEM;
	}
#endif

	ret = ipfwd_add_proc_entries(ipfwd_proc.dir, common_proc_entries, NULL);
	if (ret)
		goto common_proc_failed;	
		
#if IPFWD_ENABLE_STATS
	init_ipfwd_stats();
#endif

	return 0;

common_proc_failed:
	cvm_clean_common_proc();

	return ret;
}
