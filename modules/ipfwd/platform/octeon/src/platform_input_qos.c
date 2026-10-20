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


#include <linux/seq_file.h>

#include <asm/octeon/cvmx.h>
#include <asm/octeon/cvmx-pip-defs.h>
#include <asm/octeon/cvmx-ipd-defs.h>
#include <asm/octeon/cvmx-sso-defs.h>
#include <asm/octeon/cvmx-pow-defs.h>
#include <asm/octeon/cvmx-pow.h>
#include <asm/octeon/cvmx-helper.h>
#include <asm/octeon/cvmx-pip.h>

#include "ipfwd_proc.h"

#define IPD_RED_AVG_DLY 1000
#define IPD_RED_PRB_DLY 1000

#define ASSURED_PCT     80
#define PER_QOS_PCT     10

static cvmx_sso_ppx_qos_pri_t org_qos_pri[CVMX_MAX_CORES];
static cvmx_pow_pp_grp_mskx_t org_grp_msk[CVMX_MAX_CORES];
static cvmx_pip_qos_diffx_t org_pip_qos_diffx[64];

static cvmx_ipd_red_port_enable_t org_red_port_enable;
static cvmx_ipd_qosx_red_marks_t org_red_marks[8];
static cvmx_ipd_red_quex_param_t org_red_param[8];

extern int cvmx_helper_get_number_of_interfaces(void);

static void enable_port_qos_diff(void)
{
	cvmx_pip_prt_cfgx_t port_cfg;
	int pknd, interface, port;

	//pr_info("Enable qos_diff bit for SGMII/XAUI/RXAUI/RGMII/GMII ports\n");

	for (interface = 0; interface < cvmx_helper_get_number_of_interfaces(); interface++) {
		/* Set the frame max size and jabber size to 65535, as the defaults
			are too small. */
		cvmx_helper_interface_mode_t imode = cvmx_helper_interface_get_mode(interface);
		int num_ports = cvmx_helper_ports_on_interface(interface);

		switch (imode) {
		case CVMX_HELPER_INTERFACE_MODE_SGMII:
		case CVMX_HELPER_INTERFACE_MODE_XAUI:
		case CVMX_HELPER_INTERFACE_MODE_RXAUI:
		case CVMX_HELPER_INTERFACE_MODE_RGMII:
		case CVMX_HELPER_INTERFACE_MODE_GMII:
		case CVMX_HELPER_INTERFACE_MODE_QSGMII:
		case CVMX_HELPER_INTERFACE_MODE_AGL:

			for (port = 0; port < num_ports; port++) {
                		if (octeon_has_feature(OCTEON_FEATURE_PKND))
					pknd = cvmx_helper_get_pknd(interface, port);
				else
					pknd = cvmx_helper_get_ipd_port(interface, port);

				port_cfg.u64 = cvmx_read_csr(CVMX_PIP_PRT_CFGX(pknd));
				port_cfg.s.qos_diff = 1;
				cvmx_write_csr(CVMX_PIP_PRT_CFGX(pknd), port_cfg.u64);
			}
			break;
            	default:
                	break;
        	}
	}
}

static void enable_port_qos_watcher(void)
{
	cvmx_pip_prt_cfgx_t port_cfg;
	int pknd, interface, port;

	for (interface = 0; interface < cvmx_helper_get_number_of_interfaces(); interface++) {
	/* Set the frame max size and jabber size to 65535, as the defaults
	are too small. */
	cvmx_helper_interface_mode_t imode = cvmx_helper_interface_get_mode(interface);
	int num_ports = cvmx_helper_ports_on_interface(interface);

		switch (imode) {
		case CVMX_HELPER_INTERFACE_MODE_SGMII:
		case CVMX_HELPER_INTERFACE_MODE_XAUI:
		case CVMX_HELPER_INTERFACE_MODE_RXAUI:
		case CVMX_HELPER_INTERFACE_MODE_RGMII:
		case CVMX_HELPER_INTERFACE_MODE_GMII:
		case CVMX_HELPER_INTERFACE_MODE_QSGMII:
		case CVMX_HELPER_INTERFACE_MODE_AGL:

		for (port = 0; port < num_ports; port++) {
			if (octeon_has_feature(OCTEON_FEATURE_PKND))
				pknd = cvmx_helper_get_pknd(interface, port);
                	else
				pknd = cvmx_helper_get_ipd_port(interface, port);

			port_cfg.u64 = cvmx_read_csr(CVMX_PIP_PRT_CFGX(pknd));
			port_cfg.s.qos_wat = 1;
			cvmx_write_csr(CVMX_PIP_PRT_CFGX(pknd), port_cfg.u64);
		}
			break;
		default:
			break;
		}
	}
}

static void config_pip_qos_diffserv_table(void)
{
	int i, qos;

	//pr_info("Populate qos diffserv table\n");
	//pr_info("row 0: qos: 0 .... row 8: qos: 8 (where each row had 8 coloumns)\n");

	for (i = 0; i < 64; i++) {
		qos = (i/8);
		cvmx_pip_config_diffserv_qos(i, qos);	
	}
}

void platform_enable_ipd_red(int ipd_red_avg_dly, int ipd_red_prb_dly)
{
	cvmx_ipd_red_port_enable_t red_port_enable;

	red_port_enable.u64 = 0;
	red_port_enable.s.prt_enb = 0xfffffffffull;
	red_port_enable.s.avg_dly = ipd_red_avg_dly;
	red_port_enable.s.prb_dly = ipd_red_prb_dly;
	cvmx_write_csr(CVMX_IPD_RED_PORT_ENABLE, red_port_enable.u64);
}

void platform_enable_qos_red(int assured_pct, int per_qos_pct)
{
	uint64_t drop_thresh, pass_thresh, pkt_left;
	cvmx_ipd_qosx_red_marks_t red_marks;
	cvmx_ipd_red_quex_param_t red_param;
	unsigned int packet_termination_num = 1024;
	int queue;

	/* Set RED to begin dropping packets when there are pass_thresh buffers
	left. It will linearly drop more packets until reaching drop_thresh
	buffers */


	pkt_left = (packet_termination_num * assured_pct)/100;

	for (queue = 0; queue < 8; queue++) {
		pass_thresh = pkt_left;
		drop_thresh = pass_thresh - (packet_termination_num * per_qos_pct)/100;
		//printk("queue %d, pass_thresh %lu, drop_thresh %lu\n",
		//	queue, (unsigned long)pass_thresh, (unsigned long)drop_thresh);
		red_marks.u64 = 0;
		red_marks.s.drop = drop_thresh;
		red_marks.s.pass = pass_thresh;
		cvmx_write_csr(CVMX_IPD_QOSX_RED_MARKS(queue), red_marks.u64);

		/* Use the actual queue 0 counter, not the average */
		red_param.u64 = 0;
		red_param.s.use_pcnt = 1;
		cvmx_write_csr(CVMX_IPD_RED_QUEX_PARAM(queue), red_param.u64);
		pkt_left = drop_thresh;
	}
}

static void config_sso_q_priorities(void)
{
	int cpu, corenum;
	const uint8_t priority[] = {7,6,5,4,3,2,1,0};

	for_each_online_cpu(cpu) {
		corenum = cpu_logical_map(cpu);
		//printk("Change SSO Q priority for cpu: %d, corenum: %d\n", cpu, corenum);
		cvmx_pow_set_priority(corenum, priority);
	}
}

void platform_enable_input_qos(int ipd_red_avg_dly, 
								int ipd_red_prb_dly,
								int assured_pct, 
								int per_qos_pct)
{

	if (octeon_has_feature(OCTEON_FEATURE_PKI)) {
		/* TODO */
	} else {
		pr_info("Enable Input QOS\n");
		/* enable qos diff bit for ports */
		enable_port_qos_diff();
		
		/* enable qos watcher for ports */
		enable_port_qos_watcher();
		
		/* populate pip qos diff table */
		config_pip_qos_diffserv_table();
		
		/* enable IPD red */
		platform_enable_ipd_red(ipd_red_avg_dly, ipd_red_prb_dly);
		
		/* enable qos red */
		platform_enable_qos_red(assured_pct, per_qos_pct);
		
		/* alter SSO Q priorities do for each core */
		config_sso_q_priorities();
	}
}

/* Restore section */

static void restore_port_qos_diff(void)
{
	cvmx_pip_prt_cfgx_t port_cfg;
	int pknd, interface, port;

	//pr_info("Restore qos_diff bit for SGMII/XAUI/RXAUI/RGMII/GMII ports\n");

	for (interface = 0; interface < cvmx_helper_get_number_of_interfaces(); interface++) {
		/* Set the frame max size and jabber size to 65535, as the defaults
			are too small. */
		cvmx_helper_interface_mode_t imode = cvmx_helper_interface_get_mode(interface);
		int num_ports = cvmx_helper_ports_on_interface(interface);

		switch (imode) {
		case CVMX_HELPER_INTERFACE_MODE_SGMII:
		case CVMX_HELPER_INTERFACE_MODE_XAUI:
		case CVMX_HELPER_INTERFACE_MODE_RXAUI:
		case CVMX_HELPER_INTERFACE_MODE_RGMII:
		case CVMX_HELPER_INTERFACE_MODE_GMII:
		case CVMX_HELPER_INTERFACE_MODE_QSGMII:
		case CVMX_HELPER_INTERFACE_MODE_AGL:

			for (port = 0; port < num_ports; port++) {
                		if (octeon_has_feature(OCTEON_FEATURE_PKND))
					pknd = cvmx_helper_get_pknd(interface, port);
				else
					pknd = cvmx_helper_get_ipd_port(interface, port);

				port_cfg.u64 = cvmx_read_csr(CVMX_PIP_PRT_CFGX(pknd));
				port_cfg.s.qos_diff = 0;
				cvmx_write_csr(CVMX_PIP_PRT_CFGX(pknd), port_cfg.u64);
			}
			break;
            	default:
                	break;
        	}
	}
}

static void restore_port_qos_watcher(void)
{
	cvmx_pip_prt_cfgx_t port_cfg;
	int pknd, interface, port;

	//pr_info("Restore qos_watcher bit for SGMII/XAUI/RXAUI/RGMII/GMII ports\n");

	for (interface = 0; interface < cvmx_helper_get_number_of_interfaces(); interface++) {
		/* Set the frame max size and jabber size to 65535, as the defaults
			are too small. */
		cvmx_helper_interface_mode_t imode = cvmx_helper_interface_get_mode(interface);
		int num_ports = cvmx_helper_ports_on_interface(interface);

		switch (imode) {
		case CVMX_HELPER_INTERFACE_MODE_SGMII:
		case CVMX_HELPER_INTERFACE_MODE_XAUI:
		case CVMX_HELPER_INTERFACE_MODE_RXAUI:
		case CVMX_HELPER_INTERFACE_MODE_RGMII:
		case CVMX_HELPER_INTERFACE_MODE_GMII:
		case CVMX_HELPER_INTERFACE_MODE_QSGMII:
		case CVMX_HELPER_INTERFACE_MODE_AGL:

			for (port = 0; port < num_ports; port++) {
                		if (octeon_has_feature(OCTEON_FEATURE_PKND))
					pknd = cvmx_helper_get_pknd(interface, port);
				else
					pknd = cvmx_helper_get_ipd_port(interface, port);

				port_cfg.u64 = cvmx_read_csr(CVMX_PIP_PRT_CFGX(pknd));
				port_cfg.s.qos_wat = 0;
				cvmx_write_csr(CVMX_PIP_PRT_CFGX(pknd), port_cfg.u64);
			}
			break;
            	default:
                	break;
        	}
	}
}

static inline void restore_pip_diffserv_qos(void)
{
	int i;

	for (i = 0; i < 64; i++) {
		if (octeon_has_feature(OCTEON_FEATURE_PKND))
			;/* FIXME for 68xx. */
		else
			cvmx_write_csr(CVMX_PIP_QOS_DIFFX(i), org_pip_qos_diffx[i].u64);
	}
}

static inline void restore_ipd_red(void)
{
	cvmx_write_csr(CVMX_IPD_RED_PORT_ENABLE, org_red_port_enable.u64);
}

static inline void restore_qos_red(void)
{
	int queue;

	for (queue = 0; queue < 8; queue++) {
		cvmx_write_csr(CVMX_IPD_QOSX_RED_MARKS(queue), org_red_marks[queue].u64);
		cvmx_write_csr(CVMX_IPD_RED_QUEX_PARAM(queue), org_red_param[queue].u64);
	}
}

static void restore_sso_q_priorities(void)
{
	int cpu, corenum;
	uint8_t priority[] = {0,0,0,0,0,0,0,0};

	for_each_online_cpu(cpu) {
		corenum = cpu_logical_map(cpu);
		if (octeon_has_feature(OCTEON_FEATURE_CN68XX_WQE)) {
			priority[0] = org_qos_pri[corenum].s.qos0_pri;
			priority[1] = org_qos_pri[corenum].s.qos1_pri;
			priority[2] = org_qos_pri[corenum].s.qos2_pri;
			priority[3] = org_qos_pri[corenum].s.qos3_pri;
			priority[4] = org_qos_pri[corenum].s.qos4_pri;
			priority[5] = org_qos_pri[corenum].s.qos5_pri;
			priority[6] = org_qos_pri[corenum].s.qos6_pri;
			priority[7] = org_qos_pri[corenum].s.qos7_pri;
		} else {
			priority[0] = org_grp_msk[corenum].s.qos0_pri;
			priority[1] = org_grp_msk[corenum].s.qos1_pri;
			priority[2] = org_grp_msk[corenum].s.qos2_pri;
			priority[3] = org_grp_msk[corenum].s.qos3_pri;
			priority[4] = org_grp_msk[corenum].s.qos4_pri;
			priority[5] = org_grp_msk[corenum].s.qos5_pri;
			priority[6] = org_grp_msk[corenum].s.qos6_pri;
			priority[7] = org_grp_msk[corenum].s.qos7_pri;
		}

		cvmx_pow_set_priority(corenum, priority);
	}
}

void platform_disable_input_qos(void)
{
	if (octeon_has_feature(OCTEON_FEATURE_PKI)) {
		/* TODO */
	} else {
		pr_info("Disable Input QOS\n");
		
		restore_port_qos_diff();	
		
		restore_port_qos_watcher();
		
		restore_pip_diffserv_qos();
		
		restore_ipd_red();	
		
		restore_qos_red();
		
		restore_sso_q_priorities();
	}
}

/* Backup section */

static inline void init_cfg_variables(void)
{
	int i;

	org_red_port_enable.u64 = 0;

	for (i = 0; i < 8; i++) {
		org_red_marks[i].u64 = 0;
		org_red_param[i].u64 = 0;
	}	

	for (i = 0; i < CVMX_MAX_CORES; i++) {
		org_qos_pri[i].u64 = 0;
		org_grp_msk[i].u64 = 0;
	}

	for (i = 0; i < 64; i++) {
		org_pip_qos_diffx[i].u64 = 0;
	}
}

static inline void backup_red_config(void)
{
	int queue;

	org_red_port_enable.u64 = cvmx_read_csr(CVMX_IPD_RED_PORT_ENABLE);	

	for (queue = 0; queue < 8; queue++) {
		org_red_marks[queue].u64 = cvmx_read_csr(CVMX_IPD_QOSX_RED_MARKS(queue));
		org_red_param[queue].u64 = cvmx_read_csr(CVMX_IPD_RED_QUEX_PARAM(queue));
	}
}

static inline void backup_pip_diffserv_qos(void)
{
	int i;

	for (i = 0; i < 64; i++) {
		if (octeon_has_feature(OCTEON_FEATURE_PKND))
			;/* FIXME for 68xx. */
		else
			org_pip_qos_diffx[i].u64 = cvmx_read_csr(CVMX_PIP_QOS_DIFFX(i));
	}
}

static inline void backup_sso_config(void)
{
	int cpu, corenum;

	for_each_online_cpu(cpu) {
		corenum = cpu_logical_map(cpu);
		if (octeon_has_feature(OCTEON_FEATURE_CN68XX_WQE))
        		org_qos_pri[corenum].u64 = cvmx_read_csr(CVMX_SSO_PPX_QOS_PRI(corenum));
		else
			org_grp_msk[corenum].u64 = cvmx_read_csr(CVMX_POW_PP_GRP_MSKX(corenum));
	}
}

void platform_backup_config_info(void)
{
	if (octeon_has_feature(OCTEON_FEATURE_PKI)) {
		/* TODO */
	} else {
		init_cfg_variables();
		
		backup_red_config();
		
		backup_pip_diffserv_qos();
		
		backup_sso_config();
	}
}

int platform_input_qos_watcher_show(struct seq_file *s, void *v)
{
	cvmx_pip_qos_watchx_t qos_wat;
	int i, match_type;

	seq_printf(s, "\nWatcher#    Watcher_type    Match_value      Qos_level          Mask\n");
	for (i = 0; i < 7; i++) {
		qos_wat.u64 = 0;	
		qos_wat.u64 = cvmx_read_csr(CVMX_PIP_QOS_WATCHX(i));

		match_type = 0;
		if (OCTEON_IS_MODEL(OCTEON_CN3XXX)) {
			match_type = qos_wat.cn30xx.match_type;

		} else if (OCTEON_IS_MODEL(OCTEON_CN5XXX) ||
		 	OCTEON_IS_MODEL(OCTEON_CN61XX) ||
		 	OCTEON_IS_MODEL(OCTEON_CN63XX) ||
		 	OCTEON_IS_MODEL(OCTEON_CN66XX)) {
			match_type = qos_wat.cn50xx.match_type;
		
		} else if (OCTEON_IS_MODEL(OCTEON_CN68XX)) {
			match_type = qos_wat.cn68xx.match_type;

		} else if (OCTEON_IS_MODEL(OCTEON_CN70XX)) {
			match_type = qos_wat.cn70xx.typ;
		}
		seq_printf(s, "%d\t\t0x%0x\t\t0x%0x\t\t0x%0x\t\t0x%0x\n",
				i, match_type, qos_wat.s.match_value, qos_wat.s.qos, qos_wat.s.mask);
	}
	seq_printf(s, "\n");
		
	return 0;
}

void platform_config_port_qos_watcher(int watcher, int watcher_type, u16 match_value, u8 qos_level, u16 mask)
{
	cvmx_pip_qos_watchx_t qos_wat;

	if (OCTEON_IS_MODEL(OCTEON_CN3XXX)) {
		qos_wat.cn30xx.match_type = (watcher_type & 0x3);

	} else if (OCTEON_IS_MODEL(OCTEON_CN5XXX) ||
		 OCTEON_IS_MODEL(OCTEON_CN61XX) ||
		 OCTEON_IS_MODEL(OCTEON_CN63XX) ||
		 OCTEON_IS_MODEL(OCTEON_CN66XX)) {
		qos_wat.cn50xx.match_type = (watcher_type & 0x7);
		
	} else if (OCTEON_IS_MODEL(OCTEON_CN68XX)) {
		qos_wat.cn68xx.match_type = (watcher_type & 0x7);

	} else if (OCTEON_IS_MODEL(OCTEON_CN70XX)) {
		qos_wat.cn70xx.typ = (watcher_type & 0x7);
	}

	qos_wat.s.match_value = match_value;
	qos_wat.s.qos  = qos_level;
	qos_wat.s.mask  = mask;

	cvmx_write_csr(CVMX_PIP_QOS_WATCHX(watcher), qos_wat.u64);
}

int platform_supports_input_qos(void)
{
	return !(octeon_has_feature(OCTEON_FEATURE_PKI));
}

