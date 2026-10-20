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

#ifndef __IPFWD_FILTER_H
#define __IPFWD_FILTER_H

#include <linux/types.h>
#include <linux/spinlock_types.h>

#define CVM_IPFWD_FILTER_NOT_FOUND	-1

typedef union {
	u64 word0;
	u64 word1;
	struct {
		u16 sport;
		u16 dport;
		u32 mark;
		
		u8 action;
		u8 reserverd1;
		u16 reserved2;
		u32 reserved3;
	} s;	
} cvm_ipfwd_filter_entry_t;

typedef struct {
	u32 free_list;
	spinlock_t wr_lock;
} cvm_ipfwd_filter_bucket_header_t;

#define CVM_IPFWD_FILTER_LUT_BUCKETS		32
#define CVM_IPFWD_FILTER_LUT_MASK		(CVM_IPFWD_FILTER_LUT_BUCKETS - 1)
#define CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET	((CVMX_CACHE_LINE_SIZE / sizeof(cvm_ipfwd_filter_entry_t)) - 1)

typedef struct {
	cvm_ipfwd_filter_bucket_header_t	hdr;
	cvm_ipfwd_filter_entry_t		entry[CVM_IPFWD_FILTER_ENTRIES_PER_BUCKET];
} cvm_ipfwd_filter_bucket_t;

typedef struct {
	u8  flags;
	u8  proto;
	u16 sport;
	u16 dport;
	u32 mark;
	u8 action;
} filter_keys_t;

/* operations on free list */
#define NUM_FREE(x)			cvmx_pop(x)
#define SET_BIT(x, i)		((x) |= (1 << (i)))
#define CLEAR_BIT(x, i)		((x) &= ((x) ^ (1 << (i))))
#define IS_BIT_ON(x, i)		(((x) >> (i)) & 1)

/* port range (sport/dport) */
#define CVM_MAX_PORT_RANGE	100

/* filter options */
#define IPFWD_FILTER_ADD	1
#define IPFWD_FILTER_DELETE	2
#define IPFWD_FILTER_CLEAR	3

/* filter operation flags */
#define IPFWD_FILTER_PROTO	(1 << 0) 
#define IPFWD_FILTER_SPORT	(1 << 1)
#define IPFWD_FILTER_DPORT	(1 << 2)
#define IPFWD_FILTER_MARK	(1 << 3)

/* actions */
enum ipfwd_action {
	IPFWD_ACCEPT,
	IPFWD_DROP,
	IPFWD_BYPASS,
};

#define IPFWD_MARK_MASK	0x80000000

extern atomic_t cvm_ipfwd_filter;

extern int cvm_ipfwd_filter_init(void);
extern void cvm_ipfwd_filter_cleanup(void);
extern int cvm_ipfwd_filter_action(filter_keys_t *fkeys);

#endif /* __IPFWD_FILTER_H */
