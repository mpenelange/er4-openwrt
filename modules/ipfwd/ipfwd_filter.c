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

#include <linux/spinlock.h>
#include <linux/errno.h>
#include <linux/vmalloc.h>
#include <linux/seq_file.h>
#include <linux/module.h>
#include <linux/parser.h>
#include <linux/kernel.h>
#include <linux/slab.h>

#include <asm/uaccess.h>

#include "ipfwd_compat.h"
#include "ipfwd_common.h"
#include "ipfwd_proc.h"


static cvm_ipfwd_filter_bucket_t *cvm_gbl_ipfwd_filter_cache = NULL;

/** ref count for filter table */
atomic_t cvm_ipfwd_filter;

static int cvm_ipfwd_filter_find_entry(cvm_ipfwd_filter_bucket_t *bucket, filter_keys_t *fkeys)
{
	int idx;
	u32 free_list;
	cvm_ipfwd_filter_entry_t *entry = NULL;
	u8 proto = 0;
	u16 sport = 0, dport = 0;
	u32 mark = 0;

	if (!bucket)
		return CVM_IPFWD_FILTER_NOT_FOUND;

	if (fkeys->flags & IPFWD_FILTER_PROTO)
		proto = fkeys->proto;
	if (fkeys->flags & IPFWD_FILTER_SPORT)
		sport = fkeys->sport;
	if (fkeys->flags & IPFWD_FILTER_DPORT)
		dport = fkeys->dport;
	if (fkeys->flags & IPFWD_FILTER_MARK)
		mark = fkeys->mark;
		
	spin_lock(&bucket->hdr.wr_lock);
	free_list = bucket->hdr.free_list;

	for (idx = 0; idx < CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET; idx++) {
		entry = &bucket->entry[idx];	

		if (IS_BIT_ON(free_list, idx)) {
			if ((sport != entry->s.sport) || 
		 	    (dport != entry->s.dport) ||
			    (mark != entry->s.mark)) {
				continue;
			}
			spin_unlock(&bucket->hdr.wr_lock);
			return idx;
		}
	}
	spin_unlock(&bucket->hdr.wr_lock);

	return CVM_IPFWD_FILTER_NOT_FOUND;
}

static inline int FIRST_ZERO(u32 x)
{
	if (x == ((1 << (CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET)) - 1))
		return -1;

	return cvmx_pop(x ^ (x + 1));
}

static int cvm_ipfwd_filter_get_free_entry(cvm_ipfwd_filter_bucket_t *bucket)
{
	u32 free_list, idx = -1;

	if (!bucket)
		return -1;

	free_list = bucket->hdr.free_list;

	if (NUM_FREE(free_list) < CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET)
		idx = (FIRST_ZERO(free_list) - 1);

	return idx;
}

static int cvm_ipfwd_filter_add_entry(filter_keys_t *fkeys)
{
	cvm_ipfwd_filter_bucket_t *bucket;
	cvm_ipfwd_filter_entry_t *entry;
	int bkt_idx, ent_idx, free_idx;
	
	if (!fkeys)
		return -EINVAL;

	bkt_idx = platform_get_hash_filter_bucket(fkeys);
	bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];


	ent_idx = cvm_ipfwd_filter_find_entry(bucket, fkeys);
	if (ent_idx != CVM_IPFWD_FILTER_NOT_FOUND) {
		printk(KERN_INFO "Entry already present (bkt # %d, ent # %d, Skipping\n", bkt_idx, ent_idx);		
		return 0;
	}

	spin_lock(&bucket->hdr.wr_lock);
	free_idx  = cvm_ipfwd_filter_get_free_entry(bucket);	
	if (free_idx < 0) {
		printk(KERN_ERR "Failed to add entry, Entries in bkt # %d are full\n", bkt_idx);
		spin_unlock(&bucket->hdr.wr_lock);
		return -1;
	}

	entry = &bucket->entry[free_idx];	

	if (fkeys->flags & IPFWD_FILTER_SPORT) {
		entry->s.sport = fkeys->sport;
		entry->s.action = fkeys->action;
	}

	if (fkeys->flags & IPFWD_FILTER_DPORT) {
		entry->s.dport = fkeys->dport;
		entry->s.action = fkeys->action;
	}

	if (fkeys->flags & IPFWD_FILTER_MARK) {
		entry->s.mark = fkeys->mark;
		entry->s.action = fkeys->action;
	}

	SET_BIT(bucket->hdr.free_list, free_idx); 
	spin_unlock(&bucket->hdr.wr_lock);

	atomic_inc(&cvm_ipfwd_filter);

	return 0;
}

static int cvm_ipfwd_filter_delete_entry(filter_keys_t *fkeys)
{
	cvm_ipfwd_filter_bucket_t *bucket;
	cvm_ipfwd_filter_entry_t *entry;
	int bkt_idx, ent_idx;

	if (!fkeys)
		return -EINVAL;

	bkt_idx = platform_get_hash_filter_bucket(fkeys);
	bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];

	ent_idx = cvm_ipfwd_filter_find_entry(bucket, fkeys);
	if (ent_idx == CVM_IPFWD_FILTER_NOT_FOUND) {
		printk(KERN_ERR "Entry not found (sport: %u, dport: %u)\n", fkeys->sport, fkeys->dport);
		return -1;
	}
	spin_lock(&bucket->hdr.wr_lock);
	entry = &bucket->entry[ent_idx];
	entry->word0 = 0;
	CLEAR_BIT(bucket->hdr.free_list, ent_idx);
	spin_unlock(&bucket->hdr.wr_lock);	

	atomic_dec(&cvm_ipfwd_filter);

	return 0;
}

static int cvm_ipfwd_filter_show(struct seq_file *file, void *ptr)
{
	cvm_ipfwd_filter_bucket_t *bucket;		
	cvm_ipfwd_filter_entry_t *entry;
	int bkt_idx, ent_idx;

	seq_printf(file, "\n");
	seq_printf(file, "Fiter Entries (IPv4/v6)\n");
	seq_printf(file, "================================================\n");
	seq_printf(file, " SRC port | DST port |   MARK    |  Action        \n");
	seq_printf(file, "================================================\n");

	for (bkt_idx = 0; bkt_idx < CVM_IPFWD_FILTER_LUT_BUCKETS; bkt_idx++) {
		bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];	
		for (ent_idx = 0; ent_idx < CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET; ent_idx++) {
			if (IS_BIT_ON(bucket->hdr.free_list, ent_idx)) {
				entry = &bucket->entry[ent_idx];

				if (entry->s.sport) {
					seq_printf(file, "  %u      |           |           |", entry->s.sport);
					if (entry->s.action == IPFWD_BYPASS)
						seq_printf(file, "By-pass");
				}

				if (entry->s.dport) {
					seq_printf(file, "          |  %u       |           |", entry->s.dport);
					if (entry->s.action == IPFWD_BYPASS)
						seq_printf(file, "By-pass");
				}

				if (entry->s.mark) {
					seq_printf(file, "          |           |  %u       |", entry->s.mark);
					if (entry->s.action == IPFWD_ACCEPT)
						seq_printf(file, "accept");
					else if (entry->s.action == IPFWD_DROP)
						seq_printf(file, "drop");
				}

				seq_printf(file, "\n");
			}	
		}
	}

	seq_printf(file, "================================================\n");
	seq_printf(file, "\n");

	return 0;
}

static int cvm_ipfwd_filter_open(struct inode *inode, struct file *file)
{
	return single_open(file, cvm_ipfwd_filter_show, NULL);
}

enum {
	CVM_FILTER_ERR	= 0,
	CVM_PROTO	= (1 << 0),
	CVM_SRC_PORT	= (1 << 1),
	CVM_DST_PORT	= (1 << 2),
	CVM_MARK	= (1 << 3),
	CVM_MARK_ACTION = (1 << 4),
};

static const match_table_t filter_opt_tokens = {
	{ CVM_SRC_PORT,		"sport=%s"	},
	{ CVM_DST_PORT,		"dport=%s"	},
	{ CVM_MARK,		"mark=%s"	},
	{ CVM_MARK_ACTION,	"action=%s"	},
	{ CVM_FILTER_ERR,	NULL		}
};

static int cvm_ipfwd_filter_add(int flags, int protos[], int proto_count,
				int sports[], int sport_count,
				int dports[], int dport_count,
				int marks[], int mark_count,
				int mark_action)
{
	int i, ret;
	filter_keys_t fkeys;

	memset(&fkeys, 0, sizeof(filter_keys_t));

	if (flags & IPFWD_FILTER_PROTO) {
		fkeys.flags = IPFWD_FILTER_PROTO;
		for (i = 1; i <= proto_count; i++) {
			fkeys.proto = protos[i];
			ret = cvm_ipfwd_filter_add_entry(&fkeys);
			if (ret)
				return ret;
		}
		fkeys.proto = 0;
	}
		
	if (flags & IPFWD_FILTER_SPORT) {
		fkeys.flags = IPFWD_FILTER_SPORT;
		fkeys.action = IPFWD_BYPASS;
		for (i = 1; i <= sport_count; i++) {
			fkeys.sport = (sports[i] & 0xFFFF);
			ret = cvm_ipfwd_filter_add_entry(&fkeys);	
			if (ret)
				return ret;
		}
		fkeys.sport = 0;
		fkeys.action = 0;
	}
			
	if (flags & IPFWD_FILTER_DPORT) {
		fkeys.flags = IPFWD_FILTER_DPORT;
		fkeys.action = IPFWD_BYPASS;
		for (i = 1; i <= dport_count; i++) {
			fkeys.dport = (dports[i] & 0xFFFF);
			ret = cvm_ipfwd_filter_add_entry(&fkeys);	
			if (ret)
				return ret;
		}
		fkeys.dport = 0;
		fkeys.action = 0;
	}
	
	if (flags & IPFWD_FILTER_MARK) {
		fkeys.flags = IPFWD_FILTER_MARK;
		fkeys.action = mark_action;
		for (i = 1; i <= mark_count; i++) {
			fkeys.mark = marks[i];
			ret = cvm_ipfwd_filter_add_entry(&fkeys);
			if (ret)
				return ret;
		}
		fkeys.mark = 0;
		fkeys.action = 0;
	}

	return 0;
}

static int cvm_ipfwd_filter_delete(int flags, int protos[], int proto_count,
				   int sports[], int sport_count, int dports[], int dport_count,
				   int marks[], int mark_count,
				   int mark_action)
{
	int i, ret;
	filter_keys_t fkeys;

	memset(&fkeys, 0, sizeof(filter_keys_t));

	if (flags & IPFWD_FILTER_PROTO) {
		fkeys.flags = IPFWD_FILTER_PROTO;
		for (i = 1; i <= proto_count; i++) {
			fkeys.proto = protos[i];
			ret = cvm_ipfwd_filter_delete_entry(&fkeys);
			if (ret)
				return ret;
		}
		fkeys.proto = 0;
	}
		
	if (flags & IPFWD_FILTER_SPORT) {
		fkeys.flags = IPFWD_FILTER_SPORT;
		for (i = 1; i <= sport_count; i++) {
			fkeys.sport = sports[i];
			ret = cvm_ipfwd_filter_delete_entry(&fkeys);	
			if (ret)
				return ret;
		}
		fkeys.sport = 0;
	}
			
	if (flags & IPFWD_FILTER_DPORT) {
		fkeys.flags = IPFWD_FILTER_DPORT;
		for (i = 1; i <= dport_count; i++) {
			fkeys.dport = dports[i];
			ret = cvm_ipfwd_filter_delete_entry(&fkeys);	
			if (ret)
				return ret;
		}
		fkeys.dport = 0;
	}
	
	if (flags & IPFWD_FILTER_MARK) {
		fkeys.flags = IPFWD_FILTER_MARK;
		for (i = 1; i <= mark_count; i++) {
			fkeys.mark = marks[i];
			ret = cvm_ipfwd_filter_delete_entry(&fkeys);
			if (ret)
				return ret;
		}
		fkeys.mark = 0;
	}

	return 0;
}

static int cvm_ipfwd_filter_clear(void)
{
	cvm_ipfwd_filter_bucket_t *bucket;		
	cvm_ipfwd_filter_entry_t *entry;
	int bkt_idx, ent_idx;

	for (bkt_idx = 0; bkt_idx < CVM_IPFWD_FILTER_LUT_BUCKETS; bkt_idx++) {

		bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];	
		for (ent_idx = 0; ent_idx < CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET; ent_idx++) {

			if (IS_BIT_ON(bucket->hdr.free_list, ent_idx)) {

				spin_lock(&bucket->hdr.wr_lock);
				entry = &bucket->entry[ent_idx];
				entry->word0 = 0;
				CLEAR_BIT(bucket->hdr.free_list, ent_idx);
				spin_unlock(&bucket->hdr.wr_lock);	

				atomic_dec(&cvm_ipfwd_filter);
			}
		}	
	}

	return 0;
}

static int cvm_ipfwd_filter_operation(int action, int flags, int protos[], int proto_count,
				      int sports[], int sport_count, int dports[], int dport_count,
				      int marks[], int mark_count,
				      int mark_action)
{
	int ret;


	if (action == IPFWD_FILTER_ADD) {
		ret = cvm_ipfwd_filter_add(flags, protos, proto_count, sports, sport_count, dports, dport_count,
				 	   marks, mark_count, mark_action);
		if (ret) {
			printk(KERN_ERR "Failed to add entries to Filter Table\n");
			return ret;
		}
	} else if (action == IPFWD_FILTER_DELETE) {
		ret = cvm_ipfwd_filter_delete(flags, protos, proto_count, sports, sport_count, dports, dport_count,
					      marks, mark_count, mark_action);
		if (ret) {
			printk(KERN_ERR "Failed to delete entries from Filter Table\n");
			return ret;
		}
	} else if (action == IPFWD_FILTER_CLEAR) {
		ret = cvm_ipfwd_filter_clear();
		if (ret) {
			printk(KERN_ERR "Failed to delete entries from Filter Table\n");
			return ret;
		}
	}

	return 0;
}

static ssize_t cvm_ipfwd_filter_write(struct file *file, const char __user *buffer,
				      size_t count, loff_t *ppos)
{
	char str[count + 1];
	char *p, *pstrip, *sptr, *cmd;
	int token;
	substring_t args[MAX_OPT_ARGS];
	int protos[10], sports[CVM_MAX_PORT_RANGE], dports[CVM_MAX_PORT_RANGE], marks[10];
	int action, flags = 0;
	int mark_action = IPFWD_BYPASS;

	if (copy_from_user(str, buffer, count))
		return -EFAULT;

	str[count] = '\0';
	sptr = str;
	
	p = strsep(&sptr, " ");
	if (!p)
		return -EINVAL;

	cmd = strstrip(p);
	
	if (!strcmp(cmd, "add"))
		action = IPFWD_FILTER_ADD;
	else if (!strcmp(cmd, "del"))
		action = IPFWD_FILTER_DELETE;
	else if (!strcmp(cmd, "clr")) {
		action = IPFWD_FILTER_CLEAR;
	}
	else {
		printk(KERN_ERR "Invalid action on Filter table\n");
		return -EINVAL;
	}

	while ((p = strsep(&sptr, " \n")) != NULL) {
		if (!*p)
			continue;

		token = match_token(p, filter_opt_tokens, args);
		switch (token) {
		case CVM_PROTO:
			p = match_strdup(args);
			if (!p)
				return -ENOMEM;
			memset(protos, 0, sizeof(protos));
			get_options(p, ARRAY_SIZE(protos), protos);
			if (protos[0] < 1) {
				printk(KERN_ERR "No Protocol(s) specified\n");
				kfree(p);
				return -EINVAL;
			}
			flags |= IPFWD_FILTER_PROTO;
			kfree(p);
			break;
		case CVM_SRC_PORT:
			p = match_strdup(args);
			if (!p)
				return -ENOMEM;
			memset(sports, 0, sizeof(sports));
			get_options(p, ARRAY_SIZE(sports), sports);
			if (sports[0] < 1) {
				printk(KERN_ERR "No Source port(s) specified\n");
				kfree(p);
				return -EINVAL;
			}
			flags |= IPFWD_FILTER_SPORT;
			kfree(p);
			break;
		case CVM_DST_PORT:
			p = match_strdup(args);
			if (!p)
				return -ENOMEM;
			memset(dports, 0, sizeof(dports));
			get_options(p, ARRAY_SIZE(dports), dports);
			if (dports[0] < 1) {
				printk(KERN_ERR "No Destination port(s) specified\n");
				kfree(p);
				return -EINVAL;
			}
			flags |= IPFWD_FILTER_DPORT;
			kfree(p);
			break;
		case CVM_MARK:
			p = match_strdup(args);
			if (!p)
				return -ENOMEM;
			memset(marks, 0, sizeof(marks));
			get_options(p, ARRAY_SIZE(marks), marks);
			if (marks[0] < 1) {
				printk(KERN_ERR "No Mark(s) specified\n");
				kfree(p);
				return -EINVAL;
			}
			flags |= IPFWD_FILTER_MARK;
			kfree(p);
			break;
		case CVM_MARK_ACTION:
			p = match_strdup(args);
			if (!p)
				return -ENOMEM;
			pstrip = strstrip(p);
			if (!strcmp(pstrip, "accept"))
				mark_action = IPFWD_ACCEPT;
			else if (!strcmp(pstrip, "drop"))
				mark_action = IPFWD_DROP;
			else {
				printk(KERN_ERR "Invalid Mark Action\n");	
				kfree(p);
				return -EINVAL;
			}
			kfree(p);
			break;
		}
	}

	cvm_ipfwd_filter_operation(action, flags, protos, protos[0], sports, sports[0], dports, dports[0], marks, marks[0], mark_action);	


	return count;
}

static struct ipfwd_proc_ops cvm_ipfwd_filter_ops = {
	IPFWD_PROC_OWNER
	IPFWD_PROC_OPEN		= cvm_ipfwd_filter_open,
	IPFWD_PROC_READ		= seq_read,
	IPFWD_PROC_LSEEK		= seq_lseek,
	IPFWD_PROC_WRITE		= cvm_ipfwd_filter_write,
	IPFWD_PROC_RELEASE	= single_release,
};

static int cvm_ipfwd_filter_init_proc(void)
{
	ipfwd_proc.filter = proc_create_data("filter", 0644, ipfwd_proc.dir, &cvm_ipfwd_filter_ops, NULL);
	if (!ipfwd_proc.filter) {
		printk(KERN_ERR "Failed to create /proc/cavium/filter\n");
		return -ENOMEM;
	}
	printk(KERN_INFO "\ncreating /proc/cavium/filter\n");

	return 0;
}

static void cvm_ipfwd_filter_clean_proc(void)
{
	if(!ipfwd_proc.dir) {
		printk(KERN_INFO"/proc/cavium removed.\n");
		return;
	}

	if (ipfwd_proc.filter)
		remove_proc_entry("filter", ipfwd_proc.dir);
}

int cvm_ipfwd_filter_init(void)
{
	cvm_ipfwd_filter_bucket_t *bucket;
	cvm_ipfwd_filter_entry_t *entry;
	int i, j, ret;

	cvm_gbl_ipfwd_filter_cache = (cvm_ipfwd_filter_bucket_t *)vmalloc(sizeof(cvm_ipfwd_filter_entry_t) * CVM_IPFWD_FILTER_LUT_BUCKETS);
	if (!cvm_gbl_ipfwd_filter_cache) {
		printk(KERN_ERR "Failed to allocate (%lu bytes) memory for IP Filter cache\n",
			(sizeof(cvm_ipfwd_filter_bucket_t) * CVM_IPFWD_FILTER_LUT_BUCKETS));
		return -ENOMEM;
	}

	/* Initialize all entries to zero */
	for (i = 0; i < CVM_IPFWD_FILTER_LUT_BUCKETS; i++) {
		bucket = &cvm_gbl_ipfwd_filter_cache[i];
		spin_lock_init(&bucket->hdr.wr_lock);
		bucket->hdr.free_list = 0;
		for (j = 0; j < CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET; j++) {
			entry = &bucket->entry[j];
			entry->word0 = 0;
		}
	}

	ret = cvm_ipfwd_filter_init_proc();
	if (ret) {
		printk(KERN_ERR "IPv4 Filter init proc failed\n");
		goto ipv4_filter_failed;
	}

	atomic_set(&cvm_ipfwd_filter, 0);

	return 0;

ipv4_filter_failed:
	if (cvm_gbl_ipfwd_filter_cache)
		vfree((void *)cvm_gbl_ipfwd_filter_cache);
	cvm_gbl_ipfwd_filter_cache = NULL;

	return ret;
}

void cvm_ipfwd_filter_cleanup(void)
{
	if (cvm_gbl_ipfwd_filter_cache)
		vfree((void *)cvm_gbl_ipfwd_filter_cache);

	cvm_gbl_ipfwd_filter_cache = NULL;

	cvm_ipfwd_filter_clean_proc();
}

int cvm_ipfwd_filter_action(filter_keys_t *fkeys)
{
	cvm_ipfwd_filter_bucket_t *bucket = NULL;
	cvm_ipfwd_filter_entry_t *entry = NULL;
	int bkt_idx, ret;
	int flags;

	if (!fkeys)
		return -EINVAL;

	flags = fkeys->flags;

	if (flags & IPFWD_FILTER_PROTO) {
		/* Find based on protocol */
		fkeys->flags = IPFWD_FILTER_PROTO;
		bkt_idx = platform_get_hash_filter_bucket(fkeys);
		bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];

		ret = cvm_ipfwd_filter_find_entry(bucket, fkeys);
		if (ret != CVM_IPFWD_FILTER_NOT_FOUND)
			goto found;
		
	}

	if (flags & IPFWD_FILTER_SPORT) {
		/* Find based on sport */
		fkeys->flags = IPFWD_FILTER_SPORT;
		bkt_idx = platform_get_hash_filter_bucket(fkeys);
		bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];

		ret = cvm_ipfwd_filter_find_entry(bucket, fkeys);
		if (ret != CVM_IPFWD_FILTER_NOT_FOUND)
			goto found;
	}

	if (flags & IPFWD_FILTER_DPORT) {
		/* Find based on dport */
		fkeys->flags = IPFWD_FILTER_DPORT;
		bkt_idx = platform_get_hash_filter_bucket(fkeys);
		bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];

		ret = cvm_ipfwd_filter_find_entry(bucket, fkeys);
		if (ret != CVM_IPFWD_FILTER_NOT_FOUND)
			goto found;
	}

	if (flags & IPFWD_FILTER_MARK) {
		/* Find based on mark */
		fkeys->flags = IPFWD_FILTER_MARK;
		bkt_idx = platform_get_hash_filter_bucket(fkeys);
		bucket = &cvm_gbl_ipfwd_filter_cache[bkt_idx];

		ret = cvm_ipfwd_filter_find_entry(bucket, fkeys);
		if (ret != CVM_IPFWD_FILTER_NOT_FOUND)
			goto found;
	}

found:
	fkeys->flags = flags;
	entry = &bucket->entry[ret];

	return (entry->s.action);
}
