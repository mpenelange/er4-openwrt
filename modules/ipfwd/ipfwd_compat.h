/* SPDX-License-Identifier: GPL-2.0-only */
/*
 * Kernel API compatibility for building on 5.4 (UEK6) and 5.15+ (UEK7).
 */
#ifndef __IPFWD_COMPAT_H__
#define __IPFWD_COMPAT_H__

#include <linux/version.h>
#include <linux/proc_fs.h>

/* 5.6 moved /proc files from struct file_operations to struct proc_ops */
#if LINUX_VERSION_CODE >= KERNEL_VERSION(5, 6, 0)
#define ipfwd_proc_ops		proc_ops
#define IPFWD_PROC_OWNER
#define IPFWD_PROC_OPEN		.proc_open
#define IPFWD_PROC_READ		.proc_read
#define IPFWD_PROC_WRITE	.proc_write
#define IPFWD_PROC_LSEEK	.proc_lseek
#define IPFWD_PROC_RELEASE	.proc_release
#else
#define ipfwd_proc_ops		file_operations
#define IPFWD_PROC_OWNER	.owner = THIS_MODULE,
#define IPFWD_PROC_OPEN		.open
#define IPFWD_PROC_READ		.read
#define IPFWD_PROC_WRITE	.write
#define IPFWD_PROC_LSEEK	.llseek
#define IPFWD_PROC_RELEASE	.release
#endif

#endif /* __IPFWD_COMPAT_H__ */
