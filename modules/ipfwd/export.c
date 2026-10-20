#include <linux/if_vlan.h>
#include <linux/ppp_defs.h>
#include <linux/if_pppox.h>
#include <linux/proc_fs.h>
#include <linux/fs.h>
#include <linux/seq_file.h>
#include <linux/mutex.h>

#include "ipfwd_compat.h"
#include "export.h"
#include "ipfwd.h"


static void export_it(cvm_ipfwd_flow_entry_t *entry, 
                      cvm_ipfwd_flow_info_t *flow_info,
                      export_flow_t *f)
{
#ifdef FLOW_COUNTERS
    f->packets = atomic_long_xchg(&flow_info->rx.packets, 0);
    if (f->packets == 0)
        return;
    f->bytes = atomic_long_xchg(&flow_info->rx.bytes, 0);
#endif
    f->saddr = entry->s.ip_saddr;
    f->daddr = entry->s.ip_daddr;
    f->tx_saddr = flow_info->ip_saddr;
    f->tx_daddr = flow_info->ip_daddr;
    f->sport = entry->s.l4_sport;
    f->dport = entry->s.l4_dport;
    f->tx_ports = flow_info->ports;
    f->proto = entry->s.ip_proto;
    f->tx_proto = flow_info->ip_proto;
#ifdef DPI
    f->dpi_final = flow_info->dpi_flags;
    f->dpi_cat = flow_info->dpi_cat;
    f->dpi_app = flow_info->dpi_app;
#endif
    f->magic = EXPORT_MAGIC;
}

extern cvm_ipfwd_flow_bucket_t *cvm_gbl_ipv4_fwd_cache;
extern bool cvm_ipv4_export;
extern struct mutex cvm_ipfwd_table_mutex;

static uint64_t export_count; 

/*
 * The table mutex is held from start to stop (seq_file always calls stop, also
 * when start returns NULL), so the cache can't be freed or resized under a
 * read. It can be resized between two read() calls; a reader then simply sees
 * EOF early (or misses buckets) and gets no 'B' trailer.
 */
static void *export_seq_start(struct seq_file *s, loff_t *pos)
{
    loff_t *spos;

    mutex_lock(&cvm_ipfwd_table_mutex);

    if (!cvm_ipv4_export || !cvm_gbl_ipv4_fwd_cache) {
        *pos = 0;
        return NULL;
    }

    if (*pos >= ipv4_cache_size) {
        return NULL;
    }

    spos = kmalloc(sizeof(loff_t), GFP_KERNEL);
    if (! spos)
        return NULL;
    if (*pos == 0 ) { 
        export_count = 0;
    }
    *spos = *pos;
    return spos;
}

static void *export_seq_next(struct seq_file *s, void *v, loff_t *pos)
{
    loff_t *spos = (loff_t *) v;
    *pos = ++(*spos);
    if (*pos >= ipv4_cache_size) {	/* EOF; rewinding to 0 here made reads never end */
        return NULL;
    }
    return spos;
}

static void export_seq_stop(struct seq_file *s, void *v)
{
    kfree(v);
    mutex_unlock(&cvm_ipfwd_table_mutex);
}

static int export_seq_show(struct seq_file *s, void *v)
{
    loff_t *spos = (loff_t *) v;
    export_flow_t f[CVM_IPFWD_ENTRIES_PER_BUCKET], *fp;
    cvm_ipfwd_flow_bucket_t *bucket     = NULL;
    cvm_ipfwd_flow_entry_t  *flow_entry = NULL;
    cvm_ipfwd_flow_info_t *flow_info    = NULL;
    int ent_no;
    unsigned long flags;
   
    if (*spos >= ipv4_cache_size) {
        printk("Error: bad position %d\n", (int)*spos);
        return -1;
    }

    bucket = &cvm_gbl_ipv4_fwd_cache[*spos];
    if (bucket == NULL) {
        return -1;
    }
    memset(&f, 0, sizeof(f));
    spin_lock_irqsave(&bucket->hdr.wr_lock, flags);
    for (ent_no = 0; ent_no < CVM_IPFWD_ENTRIES_PER_BUCKET; ent_no++) {
        flow_entry = &bucket->entry[ent_no];
        if (flow_entry->s.flow_info == 0) {
            continue;
        }
        if (flow_entry->s.id0 != flow_entry->s.id1) {
            continue;
        }
        flow_info = phys_to_virt(flow_entry->s.flow_info << 2);
        export_it(flow_entry, flow_info, &f[ent_no]);
    }
    spin_unlock_irqrestore(&bucket->hdr.wr_lock, flags);
    for (ent_no = 0; ent_no < CVM_IPFWD_ENTRIES_PER_BUCKET; ent_no++) {
        fp = &f[ent_no];
        if (fp->magic == EXPORT_MAGIC) {
            seq_putc(s, 'A');
            seq_write(s, fp, sizeof(export_flow_t));
            export_count++;
        }
    }
    if (*spos == (ipv4_cache_size - 1)) {
        seq_putc(s, 'B');
        seq_write(s, &export_count, sizeof(uint64_t));
    }
    return 0;
}

static struct seq_operations export_seq_ops = {
    .start = export_seq_start,
    .next  = export_seq_next,
    .stop  = export_seq_stop,
    .show  = export_seq_show
};

static int export_open(struct inode *inode, struct file *file)
{
    return seq_open(file, &export_seq_ops);
}

static struct ipfwd_proc_ops export_file_ops = {
    IPFWD_PROC_OWNER
    IPFWD_PROC_OPEN    = export_open,
    IPFWD_PROC_READ    = seq_read,
    IPFWD_PROC_LSEEK  = seq_lseek,
    IPFWD_PROC_RELEASE = seq_release
};

int export_init(void)
{
    if (!proc_create("cavium/ipv4/flows", 0600, NULL, &export_file_ops))
        return -ENOMEM;

    return 0;
}

void export_exit(void)
{
    remove_proc_entry("cavium/ipv4/flows", NULL);
}
