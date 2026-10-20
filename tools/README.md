# tools/

Build scripts. See [docs/building.md](../docs/building.md) for the whole procedure.

- `build-openwrt.sh` — build the installable image and copy it to `images/` (with a
  `.sha256`).
- `kernel-config.sh` — regenerate `openwrt/target/linux/er4/config-5.15` from
  `configs/er4.fragment`, after editing the fragment. Downloads the Bootlin cross toolchain it
  needs into `toolchains/` the first time.
- `release.sh` — package the last build with its complete source as a dated release, and
  optionally publish it on GitHub.
- `gen-zoneinfo.py` — regenerate the UI's time-zone table from the build host's tzdata.
- `container/Containerfile` — the build container (rootless podman).
