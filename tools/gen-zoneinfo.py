#!/usr/bin/env python3
# Regenerate openwrt/package/utils/er4-ui/files/zoneinfo.json: zone name -> POSIX TZ string, for
# the System page's time zone list (er4.timezones). Source: the build host's tzdata (zone.tab for
# the names, the POSIX footer of each TZif file for the rule). Run when tzdata rules change:
#   python3 -I tools/gen-zoneinfo.py [/usr/share/zoneinfo]
import json, pathlib, sys

zi = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/usr/share/zoneinfo')
out = pathlib.Path(__file__).resolve().parent.parent / 'openwrt/package/utils/er4-ui/files/zoneinfo.json'

names = {'UTC'}
for line in (zi / 'zone.tab').read_text().splitlines():
    if line and not line.startswith('#'):
        names.add(line.split('\t')[2])

zones = {}
for n in sorted(names):
    data = (zi / n).read_bytes()
    if not data.startswith(b'TZif') or data[4:5] < b'2':
        sys.exit(f'{n}: no TZif v2+ footer')
    zones[n] = data.rstrip(b'\n').rsplit(b'\n', 1)[1].decode()
    if not zones[n]:
        sys.exit(f'{n}: empty POSIX rule')

out.write_text(json.dumps(zones, indent=0, sort_keys=True) + '\n')
print(f'{len(zones)} zones -> {out}')
