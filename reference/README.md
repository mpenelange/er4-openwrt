# Reference

`openwrt-dts/` holds unchanged copies of upstream OpenWrt's ER-4 device tree (OpenWrt v25.12.5,
`target/linux/octeon/files/arch/mips/boot/dts/cavium-octeon/`; license as in their SPDX
headers). The build doesn't use them, because the stock U-Boot passes its own device tree. They
are here to compare with upstream's port, which names the ports `lan0`–`lan3`.
