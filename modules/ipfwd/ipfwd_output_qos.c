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

#include "ipfwd_compat.h"
#include "ipfwd_output_qos.h"

#if (IPFWD_OUTPUT_QOS)
#ifdef CONFIG_PROC_FS
#include <linux/proc_fs.h>
#endif
#include <linux/moduleparam.h>
#include <linux/skbuff.h>
#include <linux/ip.h>
#include <linux/netdevice.h>

#include "ipfwd_common.h"

struct proc_dir_entry *cvm_oct_op_qos;

static bool cvm_oct_output_qos __read_mostly = true;
module_param_named(output_qos, cvm_oct_output_qos, bool, 0644);
MODULE_PARM_DESC(output_qos, "Enable Output qos");

int calculate_ipv4_skb_qos_level(struct sk_buff *skb, struct iphdr *ip)
{
	int qos_level = 0;
	u8 tos = IPTOS_PREC(ip->tos) >> 5;
	u32 qos_output_map;
	int tx_queues;

	if (!cvm_oct_output_qos)
		return 0;

	qos_output_map = platform_qos_output_map_get(skb, &tx_queues);
	qos_level = (qos_output_map >> (tos * 4)) & 0x7;

	if (qos_level >= tx_queues)
		qos_level = tx_queues - 1;

	return qos_level;
}

static int output_qos_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_oct_output_qos);

	return 0;
}

static int output_qos_open(struct inode *inode, struct file *file)
{
	return single_open(file, output_qos_show, NULL);
}

static ssize_t output_qos_write(struct file *file, const char __user *input,
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

	pr_info("Output Qos %s\n", (val ? "Enabled" : "Disabled"));

	if (val)
		cvm_oct_output_qos = true;
	else
		cvm_oct_output_qos = false;

	return size;
}
static const struct ipfwd_proc_ops output_qos_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= output_qos_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= output_qos_write,
};

int ipfwd_output_qos_init(void)
{
	if (!platform_supports_output_qos()) {
		/*
		 * TODO
		 */
	} else {
		pr_info("OUTPUT QOS initialization\n");
		
		cvm_oct_op_qos = proc_create_data("octeon_output_qos", 0644, NULL, &output_qos_proc_fops, NULL);
		if (!cvm_oct_op_qos) {
			pr_err("Failed to create /proc/octeon_output_qos entry\n");
			return -ENOMEM;
		}
		pr_info("created /proc/octeon_output_qos\n");
		
		platform_show_output_qos_config();
		
	}
	return 0;
}

void ipfwd_output_qos_exit(void)
{
	if (!platform_supports_output_qos()) {
		/*
		 * TODO
		 */
	} else {
		pr_info("OUTPUT QOS exit\n");

		remove_proc_entry("octeon_output_qos", NULL);
	}
}
#endif
