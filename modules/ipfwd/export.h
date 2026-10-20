#ifndef _EXPORT_H_
#define _EXPORT_H_

extern int export_init(void);
extern void export_exit(void);

#define EXPORT_MAGIC 0xBABE

typedef struct {
    uint32_t   saddr;
    uint32_t   daddr;

    uint32_t   tx_saddr;
    uint32_t   tx_daddr;

    uint16_t   sport;
    uint16_t   dport;
    uint32_t   tx_ports;

    uint64_t   packets;

    uint64_t   bytes;

    uint8_t    proto;
    uint8_t    tx_proto;
    uint8_t    dpi_final;
    uint8_t    dpi_cat;
    uint16_t   dpi_app;
    uint16_t   magic;
} export_flow_t;

#endif /* _EXPORT_H_ */
