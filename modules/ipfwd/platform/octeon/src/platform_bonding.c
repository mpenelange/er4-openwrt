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

#include <linux/version.h>
#include "platform_api.h"

int platform_set_bonding_fastpath(struct sk_buff *skb, unsigned long* pkt_flags, 
									u8* oct_odev) 
{
	struct bonding *bond = netdev_priv(skb->dev);

	if(bond->params.mode == BOND_MODE_ROUNDROBIN || 
		bond->params.mode == BOND_MODE_ACTIVEBACKUP) {

		/* For now, use bonding fastpath only if all slaves are oct_devs */

		struct slave* slave;
		struct list_head *iter;

		bond_for_each_slave(bond, slave, iter) {
			if(!slave->dev->is_cvm_dev) {
				*oct_odev = 0;
				return -1;
			}
		}

		*oct_odev = 1;
		set_bonding_fastpath(pkt_flags);
	}
	return 0;
}

static int cvm_fastpath_bonding_roundrobin(struct sk_buff* skb, struct bonding* bond)
{
	int slave_no;
	struct slave *slave;
	int tries = bond->slave_cnt;
	struct list_head *iter;

	do {
#if LINUX_VERSION_CODE >= KERNEL_VERSION(5, 12, 0)
		/* 5.12 made rr_tx_counter per-CPU (see bond_rr_gen_slave_id()) */
		slave_no = this_cpu_inc_return(*bond->rr_tx_counter) % bond->slave_cnt;
#else
		slave_no = bond->rr_tx_counter++ % bond->slave_cnt;
#endif
		bond_for_each_slave(bond, slave, iter) {
			if(--slave_no < 0) {
				if( (slave->dev->flags & IFF_UP) && 
						netif_running(slave->dev) && 
						netif_carrier_ok(slave->dev) && 
						(slave->link == BOND_LINK_UP)) {
					skb->dev = slave->dev;
					return 0;
				}
			}
		}
	} while(--tries > 0);

	return -1;
}

static int cvm_fastpath_bonding_activebackup(struct sk_buff* skb, struct bonding* bond)
{
	int ret = -1;

	if(bond->curr_active_slave)
		if( (bond->curr_active_slave->dev->flags & IFF_UP) && netif_running(bond->curr_active_slave->dev) && netif_carrier_ok(bond->curr_active_slave->dev)){
			skb->dev = bond->curr_active_slave->dev;
			ret = 0;
		}

	return ret;
}

int platform_process_bonding_fastpath(struct sk_buff *skb) 
{
	struct bonding *bond = netdev_priv(skb->dev);
	int fastpath_bond_failed = 0;

	bond = netdev_priv(skb->dev);	

	switch(bond->params.mode){

		case BOND_MODE_ROUNDROBIN:
			fastpath_bond_failed = cvm_fastpath_bonding_roundrobin(skb,bond);
			break;

		case BOND_MODE_ACTIVEBACKUP:
			fastpath_bond_failed = cvm_fastpath_bonding_activebackup(skb,bond);
			break;

		default:
			break;
	}
		
	return 0;
}
