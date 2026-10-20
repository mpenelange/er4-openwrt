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

#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/types.h>
#include <linux/parser.h>
#include <linux/seq_file.h>
#ifdef CONFIG_PROC_FS
#include <linux/proc_fs.h>
#endif

#include "ipfwd_compat.h"
#include "ipfwd_common.h"
#include "ipfwd_proc.h"

#define IPD_RED_AVG_DLY 1000
#define IPD_RED_PRB_DLY 1000

#define ASSURED_PCT     80
#define PER_QOS_PCT     10

static bool cvm_input_qos __read_mostly = true;
module_param_named(input_qos, cvm_input_qos, bool, 0644);
MODULE_PARM_DESC(input_qos, "Input QOS");

static int ipd_red_avg_dly = IPD_RED_AVG_DLY;
module_param_named(red_avg_dly, ipd_red_avg_dly, int, 0644);
MODULE_PARM_DESC(red_avg_dly, "Average Queue size delay");

static int ipd_red_prb_dly = IPD_RED_PRB_DLY;
module_param_named(red_prb_dly, ipd_red_prb_dly, int, 0644);
MODULE_PARM_DESC(red_prb_dly, "Pass drop probability delay");

static int assured_pct = ASSURED_PCT;
module_param(assured_pct, int, 0644);

static int per_qos_pct = PER_QOS_PCT;
module_param(per_qos_pct, int, 0644);

extern int cvmx_helper_get_number_of_interfaces(void);

#ifdef CONFIG_PROC_FS
static struct proc_dir_entry *qos_proc_dir;
static struct proc_dir_entry *input_qos_proc_dir;

static int input_qos_enable_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", cvm_input_qos);

	return 0;
}

static int input_qos_enable_open(struct inode *inode, struct file *file)
{
	return single_open(file, input_qos_enable_show, NULL);
}

static ssize_t input_qos_enable_write(struct file *file, const char __user *input,
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

	pr_info("Input Qos %s\n", (val ? "Enabled" : "Disabled"));

	if (val) {
		platform_enable_input_qos(ipd_red_avg_dly, ipd_red_prb_dly, assured_pct, per_qos_pct);
		cvm_input_qos = true;
		set_bit(CVM_INPUT_QOS_BIT, &ipfwd_flags);
	} else {
		platform_disable_input_qos();
		cvm_input_qos = false;
		clear_bit(CVM_INPUT_QOS_BIT, &ipfwd_flags);
	}

	return size;
}

static const struct ipfwd_proc_ops input_qos_enable_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= input_qos_enable_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= input_qos_enable_write,	
};

static int input_qos_red_avg_dly_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", ipd_red_avg_dly);

	return 0;
}

static int input_qos_red_avg_dly_open(struct inode *inode, struct file *file)
{
	return single_open(file, input_qos_red_avg_dly_show, NULL);
}

static ssize_t input_qos_red_avg_dly_write(struct file *file, const char __user *input,
						size_t size, loff_t *ofs)
{
	char buffer[32];

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = '\0';

	ipd_red_avg_dly = simple_strtoul(buffer, NULL, 10);

	platform_enable_ipd_red(ipd_red_avg_dly, ipd_red_prb_dly);

	return size;
}

static const struct ipfwd_proc_ops input_qos_red_avg_dly_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= input_qos_red_avg_dly_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= input_qos_red_avg_dly_write,	
};

static int input_qos_red_prb_dly_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", ipd_red_prb_dly);

	return 0;
}

static int input_qos_red_prb_dly_open(struct inode *inode, struct file *file)
{
	return single_open(file, input_qos_red_prb_dly_show, NULL);
}

static ssize_t input_qos_red_prb_dly_write(struct file *file, const char __user *input,
						size_t size, loff_t *ofs)
{
	char buffer[32];

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = '\0';

	ipd_red_prb_dly = simple_strtoul(buffer, NULL, 10);

	platform_enable_ipd_red(ipd_red_avg_dly, ipd_red_prb_dly);

	return size;
}

static const struct ipfwd_proc_ops input_qos_red_prb_dly_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= input_qos_red_prb_dly_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= input_qos_red_prb_dly_write,	
};

static int input_qos_assured_pct_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", assured_pct);

	return 0;
}

static int input_qos_assured_pct_open(struct inode *inode, struct file *file)
{
	return single_open(file, input_qos_assured_pct_show, NULL);
}

static ssize_t input_qos_assured_pct_write(struct file *file, const char __user *input,
						size_t size, loff_t *ofs)
{
	char buffer[32];

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = '\0';

	assured_pct = simple_strtoul(buffer, NULL, 10);

	platform_enable_qos_red(assured_pct, per_qos_pct);

	return size;
}

static const struct ipfwd_proc_ops input_qos_assured_pct_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= input_qos_assured_pct_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= input_qos_assured_pct_write,	
};

static int input_qos_per_qos_pct_show(struct seq_file *s, void *v)
{
	seq_printf(s, "%d\n", per_qos_pct);

	return 0;
}

static int input_qos_per_qos_pct_open(struct inode *inode, struct file *file)
{
	return single_open(file, input_qos_per_qos_pct_show, NULL);
}

static ssize_t input_qos_per_qos_pct_write(struct file *file, const char __user *input,
						size_t size, loff_t *ofs)
{
	char buffer[32];

	if (size >= sizeof(buffer)) {
		return -EFAULT;
	}

	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = '\0';

	per_qos_pct = simple_strtoul(buffer, NULL, 10);

	platform_enable_qos_red(assured_pct, per_qos_pct);

	return size;
}

static const struct ipfwd_proc_ops input_qos_per_qos_pct_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= input_qos_per_qos_pct_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= input_qos_per_qos_pct_write,	
};

static int input_qos_watcher_open(struct inode *inode, struct file *file)
{
	return single_open(file, platform_input_qos_watcher_show, NULL);
}

static const match_table_t qos_watcher_tokens = {
	{ CVM_QOS_WACTHER,	"watcher=%d"		},
	{ CVM_WATCHER_TYPE,	"watcher_type=%d"	},
	{ CVM_MATCH_VALUE,	"match_value=%x"	},
	{ CVM_QOS_LEVEL,	"qos_level=%d"		},
	{ CVM_QOS_MASK,		"mask=%x"		},
	{ CVM_QOS_ERR,		NULL			}
};

static int ipfwd_qos_watcher_enable(int flags, int watcher, int watcher_type, int match_value, int qos_level, int mask)
{
	int ret = 0;

	if (!(flags & CVM_QOS_WACTHER)) {
		pr_err("Please specify the watcher# (0..7)\n");
		return -EINVAL;
	}

	if (!(flags & CVM_WATCHER_TYPE)) {
		pr_err("Please specify the watcher type (0..4)\n");
		return -EINVAL;	
	}

	if (!(flags & CVM_MATCH_VALUE)) {
		pr_err("Please specify the match value (16 bit)\n");
		return -EINVAL;
	}

	if (!(flags & CVM_QOS_LEVEL))
		qos_level = 0;

	if (!(flags & CVM_QOS_MASK))
		mask = 0xffff;
		
	if ((watcher < 0) || (watcher > 7)) {
		pr_err("Invalid watcher: %d\n", watcher);
		ret = -EINVAL;
	}

	if ((qos_level < 0) || (qos_level > 7)) {
		pr_err("Invalid qos level: %d\n", qos_level);
		ret = -EINVAL;
	}

	if (ret)
		return ret;

	pr_info("proceeding with\n watcher# %d  watcher_type# 0x%0x  match_value# 0x%0x  qos_level# 0x%0x  mask# 0x%0x\n",
		watcher, watcher_type, match_value, qos_level, mask);
		 
	platform_config_port_qos_watcher(watcher, watcher_type, match_value, qos_level, mask);

	return 0;
}

static ssize_t input_qos_watcher_write(struct file *file, const char __user *input,
						size_t size, loff_t *ofs)
{
	char buffer[size + 1];
	char *p, *sptr;
	int token, ret;
	int qos_level, mask, match_value;
	int watcher, watcher_type;
	substring_t args[MAX_OPT_ARGS];
	int flags = 0;
	
	if (copy_from_user(buffer, input, size))
		return -EFAULT;

	buffer[size] = '\0';
	sptr = buffer;

	while ((p = strsep(&sptr, " \n")) != NULL) {
		if (!*p)
			continue;

		token = match_token(p, qos_watcher_tokens, args);
		switch (token) {
		case CVM_QOS_WACTHER:
			ret = match_int(args, &watcher);
			if (ret < 0) {
				pr_err("bad watcher option arg\n");
				return ret;
			}
			flags |= CVM_QOS_WACTHER;
			break;
		case CVM_WATCHER_TYPE:
			ret = match_int(args, &watcher_type);
			if (ret < 0) {
				pr_err("bad watcher option arg\n");
				return ret;
			}
			flags |= CVM_WATCHER_TYPE;
			break;
		case CVM_MATCH_VALUE:
			ret = match_hex(args, &match_value);
			if (ret < 0) {
				pr_err("bad watcher option arg\n");
				return ret;
			}
			flags |= CVM_MATCH_VALUE;
			break;
		case CVM_QOS_LEVEL:
			ret = match_int(args, &qos_level);
			if (ret < 0) {
				pr_err("bad watcher option arg\n");
				return ret;
			}
			flags |= CVM_QOS_LEVEL;
			break;
		case CVM_QOS_MASK:
			ret = match_hex(args, &mask);
			if (ret < 0) {
				pr_err("bad watcher option arg\n");
				return ret;
			}
			flags |= CVM_QOS_MASK;
			break;
		default:
			pr_err("invalid option\n");
			return -EINVAL;
			break;
		}
	}

	ipfwd_qos_watcher_enable(flags, watcher, watcher_type, match_value, qos_level, mask);	

	return size;
}
static const struct ipfwd_proc_ops input_qos_watcher_proc_fops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= input_qos_watcher_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_RELEASE	= single_release,
	IPFWD_PROC_WRITE		= input_qos_watcher_write,
};

static ipfwd_proc_entry_t input_qos_entries[] = {
	{ "enable",		S_IFREG | S_IRUSR | S_IWUSR, &input_qos_enable_proc_fops },
	{ "red_avg_dly",	S_IFREG | S_IRUSR | S_IWUSR, &input_qos_red_avg_dly_proc_fops },
	{ "red_prb_dly",	S_IFREG | S_IRUSR | S_IWUSR, &input_qos_red_prb_dly_proc_fops },
	{ "assured_pct",	S_IFREG | S_IRUSR | S_IWUSR, &input_qos_assured_pct_proc_fops },
	{ "per_qos_pct",	S_IFREG | S_IRUSR | S_IWUSR, &input_qos_per_qos_pct_proc_fops },
	{ "watcher",		S_IFREG | S_IRUSR | S_IWUSR, &input_qos_watcher_proc_fops },
	{}
};
#endif

static void input_qos_clean_proc(void)
{
	ipfwd_remove_proc_entries(input_qos_proc_dir, input_qos_entries);
#ifdef CONFIG_PROC_FS
	if (input_qos_proc_dir)
		remove_proc_entry("input", qos_proc_dir);
	if (qos_proc_dir)
		remove_proc_entry("qos", ipfwd_proc.dir);
#endif
}

static int input_qos_init_proc(void)
{
	int ret = 0;

#ifdef CONFIG_PROC_FS
	printk(KERN_INFO "\ncreating /proc/cavium/qos\n");

	/* create qos directory under /proc/cavium */
	qos_proc_dir = proc_mkdir("qos", ipfwd_proc.dir);
	if (!qos_proc_dir) {
		pr_err("failed to create /proc/cavium/qos directory\n");
		ret = -ENOMEM;
		goto input_qos_proc_failed;
	}

	printk(KERN_INFO "creating /proc/cavium/qos/input\n");

	input_qos_proc_dir = proc_mkdir("input", qos_proc_dir);
	if (!input_qos_proc_dir) {
		pr_err("failed to create /proc/cavium/qos/input directory\n");
		ret = -ENOMEM;
		goto input_qos_proc_failed;
	}
#endif

	ret = ipfwd_add_proc_entries(input_qos_proc_dir, input_qos_entries, NULL);
	if (ret)
		goto input_qos_proc_failed;

	return 0;

input_qos_proc_failed:

	input_qos_clean_proc();
	
	return ret;
}

int ipfwd_input_qos_init(void)
{
	int ret = 0;

	if (!platform_supports_input_qos()) {
		return 0;
	}
	pr_info("INPUT QOS initialization\n");

	ret = input_qos_init_proc();
	if (ret) {
		pr_err("input qos init failed\n");
		return ret;
	}	

	platform_backup_config_info();	

	if (cvm_input_qos) {
		platform_enable_input_qos(ipd_red_avg_dly, ipd_red_prb_dly, assured_pct, per_qos_pct);
		set_bit(CVM_INPUT_QOS_BIT, &ipfwd_flags);
	}

	return ret;
}

void ipfwd_input_qos_exit(void)
{
	if (!platform_supports_input_qos()) {
		return;
	}

	pr_info("INPUT QOS exit\n");

	input_qos_clean_proc();

	platform_disable_input_qos();

	clear_bit(CVM_INPUT_QOS_BIT, &ipfwd_flags);
}


