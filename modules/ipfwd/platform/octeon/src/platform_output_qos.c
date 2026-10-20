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

#include <linux/skbuff.h>
#include <linux/ip.h>
#include <linux/netdevice.h>

#include <asm/uaccess.h>

#include <ethernet-defines.h>
#include <octeon-ethernet.h>

#include <asm/octeon/cvmx-config.h>
#include <asm/octeon/cvmx-helper-cfg.h>
#include <asm/octeon/cvmx-helper.h>

#include "platform_api.h"

u32 platform_qos_output_map_get(struct sk_buff *skb, int* tx_queues)
{
	struct octeon_ethernet *priv = netdev_priv(skb->dev);
	
	*tx_queues =  priv->num_tx_queues;

    if (priv->num_tx_queues >= 8)
            return 0x01234567;

    switch (priv->num_tx_queues) {
    case 7:
            return 0x01234556;
    case 6:
            return 0x01233445;
    case 5:
            return 0x01122334;
    case 4:
            return 0x00112233;
    case 3:
            return 0x00011122;
    case 2:
            return 0x00001111;
    }

    return 0x00000000;
}

static const char *interface_mode_to_string(cvmx_helper_interface_mode_t mode)
{
	switch (mode) {
	case CVMX_HELPER_INTERFACE_MODE_DISABLED:
		return "DISABLED";
	case CVMX_HELPER_INTERFACE_MODE_RGMII:
		return "RGMII";
	case CVMX_HELPER_INTERFACE_MODE_GMII:
		return "GMII";
	case CVMX_HELPER_INTERFACE_MODE_SPI:
		return "SPI";
	case CVMX_HELPER_INTERFACE_MODE_PCIE:
		return "PCIE";
	case CVMX_HELPER_INTERFACE_MODE_XAUI:
		return "XAUI";
	case CVMX_HELPER_INTERFACE_MODE_RXAUI:
		return "RXAUI";
	case CVMX_HELPER_INTERFACE_MODE_SGMII:
		return "SGMII";
	case CVMX_HELPER_INTERFACE_MODE_QSGMII:
                return "QSGMII";
	case CVMX_HELPER_INTERFACE_MODE_PICMG:
		return "PICMG";
	case CVMX_HELPER_INTERFACE_MODE_NPI:
		return "NPI";
	case CVMX_HELPER_INTERFACE_MODE_LOOP:
		return "LOOP";
	case CVMX_HELPER_INTERFACE_MODE_SRIO:
		return "SRIO";
	case CVMX_HELPER_INTERFACE_MODE_ILK:
		return "ILK";
	case CVMX_HELPER_INTERFACE_MODE_AGL:
                return "AGL";
	case CVMX_HELPER_INTERFACE_MODE_XLAUI:
		return "XLAUI";
	case CVMX_HELPER_INTERFACE_MODE_XFI:
		return "XFI";
	case CVMX_HELPER_INTERFACE_MODE_10G_KR:
		return "10G_KR";
	case CVMX_HELPER_INTERFACE_MODE_40G_KR4:
		return "40G_KR4";
	case CVMX_HELPER_INTERFACE_MODE_MIXED:
		return "MIXED";
	}
	return "UNKNOWN";
}

void platform_show_output_qos_config(void)
{
	int num_interfaces, interface;

	num_interfaces = cvmx_helper_get_number_of_interfaces();
        for (interface = 0; interface < num_interfaces; interface++) {
                int num_ports = cvmx_helper_ports_on_interface(interface);
                int port;
		int mode = cvmx_helper_interface_get_mode(interface);
		printk("Interface %d (%s) has %d ports\n", interface, interface_mode_to_string(mode), num_ports);
                for (port = cvmx_helper_get_ipd_port(interface, 0);
                     port < cvmx_helper_get_ipd_port(interface, num_ports);
                     port++) {
			printk("port %d, pko base queue: %d, num queues: %d\n", port, cvmx_pko_get_base_queue(port),
				cvmx_pko_get_num_queues(port));
		}
	}
}

int platform_supports_output_qos(void) 
{
	return !(octeon_has_feature(OCTEON_FEATURE_PKO3));
}

