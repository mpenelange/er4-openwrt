// rpcd plugin "er4": live router state and image management for the ER-4 web UI.
// Reply shapes are the contract in ui/src/api/types.ts and ui/src/api/mock/ext/*.ts.
//
// Image layout (no A/B bootloader fallback: stock U-Boot always boots p1:vmlinux.64):
//   p1:vmlinux.64         the image U-Boot boots ("a" = running, after install "the new one")
//   p1:vmlinux.64.prev    the previous image (rollback target, "b")
//   p1:vmlinux.64.edgeos  stock EdgeOS kernel (not managed here)
// An image is the whole system (kernel + initramfs rootfs); /etc persists on p2:/er4/etc.
'use strict';

import { readfile, writefile, popen, stat, mkdir, unlink, access, lsdir } from 'fs';
import { cursor } from 'uci';

const PORTS = [ 'eth0', 'eth1', 'eth2', 'eth3' ];
const COUNTERS = [ 'rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets', 'rx_dropped', 'tx_dropped' ];
const P1 = '/mnt/er4p1';
const STATUS = '/tmp/er4-firmware.json';

function num(path) {
	const v = readfile(path);
	return v == null ? null : +trim(v);
}

function sh(cmd) {
	const p = popen(cmd);
	if (!p) return '';
	const out = p.read('all');
	p.close();
	return trim(out ?? '');
}

function q(s) {
	return `'${replace(s ?? '', "'", "'\\''")}'`;
}

function user_exists(name) {
	for (let line in split(readfile('/etc/passwd') ?? '', '\n'))
		if (split(line, ':')[0] == name) return true;
	return false;
}

// A factory-fresh /etc has root with an empty shadow field (stock OpenWrt). rpcd and dropbear
// are patched/configured not to accept that, so the UI's first-boot setup sets one instead.
function root_has_password() {
	for (let line in split(readfile('/etc/shadow') ?? '', '\n')) {
		const f = split(line, ':');
		if (f[0] == 'root') return length(f[1] ?? '') > 0;
	}
	return false;
}

function passwd(u, p) {
	return system(`(echo ${q(p)}; sleep 1; echo ${q(p)}) | /bin/busybox passwd ${q(u)} >/dev/null 2>&1`) == 0;
}

function now_ms() {
	const t = clock();
	return t[0] * 1000 + int(t[1] / 1000000);
}

function cavium_stats() {
	const out = {};
	for (let line in split(readfile('/proc/cavium/stats') ?? '', '\n')) {
		const m = match(line, /^(\S+)\s+(\d+)/);
		if (m) out[m[1]] = +m[2];
	}
	return out;
}

function sample() {
	const cpu = { total: [], idle: [] };
	for (let line in split(readfile('/proc/stat') ?? '', '\n')) {
		const m = match(line, /^cpu\d+\s+(.*)$/);
		if (!m) continue;
		const f = map(split(trim(m[1]), /\s+/), (x) => +x);
		let total = 0;
		for (let x in f) total += x;
		push(cpu.total, total);
		push(cpu.idle, f[3] + f[4]);
	}
	const ports = {};
	for (let p in PORTS) {
		ports[p] = {};
		for (let c in COUNTERS)
			ports[p][c] = num(`/sys/class/net/${p}/statistics/${c}`) ?? 0;
	}
	const cs = cavium_stats();
	return {
		time: now_ms(),
		cpu,
		ports,
		offload: {
			flow_found: cs.ipv4_flow_found ?? 0,
			flow_not_found: cs.ipv4_flow_not_found ?? 0,
			invalidations: num('/proc/cavium/invalidate') ?? 0
		},
		conntrack: {
			count: num('/proc/sys/net/netfilter/nf_conntrack_count') ?? 0,
			max: num('/proc/sys/net/netfilter/nf_conntrack_max') ?? 0
		}
	};
}

// History: rpcd keeps this plugin loaded, so samples taken by stats calls accumulate here;
// er4-statsmon calls stats every 5 s, so they do even with no UI open.
// Coarse buckets keep 24 h affordable: 2 s x 150, 15 s x 240, 120 s x 720.
const RINGS = { '300': { step: 2, keep: 150, s: [] }, '3600': { step: 15, keep: 240, s: [] }, '86400': { step: 120, keep: 720, s: [] } };
function remember(s) {
	for (let k, r in RINGS) {
		const last = r.s[length(r.s) - 1];
		if (last && s.time - last.time < r.step * 1000 - 500) continue;
		push(r.s, s);
		if (length(r.s) > r.keep) shift(r.s);
	}
}

// ---- images on p1 -------------------------------------------------------------------
function with_p1(fn) {
	mkdir(P1);
	const mounted = index(readfile('/proc/mounts') ?? '', ` ${P1} `) >= 0;
	if (!mounted && system(`mount -t vfat /dev/mmcblk0p1 ${P1} 2>/dev/null`) != 0)
		return { error: 'cannot mount mmcblk0p1' };
	const r = fn();
	if (!mounted) system(`umount ${P1}`);
	return r;
}

// Cheap on purpose: rpcd is single-threaded, so nothing here may read the 26 MB images.
// Checksums come from the .md5 sidecars written at install time.
function image_meta(path) {
	const st = stat(path);
	if (!st) return null;
	return {
		size: st.size,
		installed: st.mtime,
		md5: split(trim(readfile(`${path}.md5`) ?? ''), ' ')[0] || null
	};
}

// The build ID the image build appends after the kernel: "er4-build=<rev> k<kernel rev> <unix time>"
// (openwrt/target/linux/er4/image/Makefile). Images built before it have none (null).
function build_tag(path) {
	const t = sh(`tail -c 256 ${q(path)} 2>/dev/null | tr '\\000' '\\n' | sed -n 's/^er4-build=//p' | tail -n 1`);
	const m = match(trim(t), /^([0-9a-f]+(-dirty)?) k([0-9a-f]+(-dirty)?) ([0-9]+)$/);
	return m ? { rev: m[1], kernel: m[3], built: +m[5] } : null;
}

// What this boot came from, recorded at boot by /etc/init.d/er4-boot (the md5 sidecar of
// vmlinux.64 then); vmlinux.64 changes on install, so it can't say what's running afterwards.
const BOOTED = '/tmp/er4-booted';

function release() {
	const r = {};
	for (let line in split(readfile('/etc/openwrt_release') ?? '', '\n')) {
		const m = match(line, /^DISTRIB_(\w+)='?([^']*)'?$/);
		if (m) r[lc(m[1])] = m[2];
	}
	return r;
}

function set_status(s) {
	writefile(STATUS, sprintf('%J', s));
	return s;
}

function get_status() {
	return json(readfile(STATUS) ?? '{"state":"idle","progress":0}');
}

function verify(path) {
	const checks = [];
	const st = stat(path);
	const head = st ? sh(`head -c 20 ${q(path)} | hexdump -v -e '1/1 "%02x"'`) : '';
	// ELF64, big-endian, MIPS (e_machine 8)
	const elf = substr(head, 0, 8) == '7f454c46' && substr(head, 8, 4) == '0202' && substr(head, 36, 4) == '0008';
	push(checks, { id: 'format', label: 'MIPS64 big-endian ELF kernel image', ok: elf, detail: st ? (elf ? 'ok' : 'not a firmware image') : 'file missing' });
	const meta = st ? { size: st.size, sha256: split(sh(`sha256sum ${q(path)}`), ' ')[0] } : null;
	const er4 = st && elf ? sh(`grep -a -F -c -m1 'ubnt,edgerouter-4' ${q(path)}`) : '0';
	push(checks, { id: 'board', label: 'Built for ubnt,edgerouter-4', ok: elf && +er4 > 0, detail: +er4 > 0 ? 'board name found in the image' : 'board name not found' });
	push(checks, { id: 'sha256', label: 'SHA-256', ok: null, detail: meta?.sha256 ?? '' });
	const free = with_p1(() => +sh(`df -k ${P1} | awk 'NR==2{print $4}'`) * 1024);
	const fits = st && type(free) == 'int' && st.size < free + (stat(`${P1}/vmlinux.64.prev`)?.size ?? 0);
	push(checks, { id: 'size', label: 'Fits on the boot partition', ok: !!fits, detail: st ? sprintf('%d MB', st.size / 1048576) : '' });
	return { valid: elf && +er4 > 0 && !!fits, checks, image: meta ? { ...meta, build: build_tag(path), version: null } : null };
}

// ---- diagnostics ----------------------------------------------------------------------
// rpcd is single-threaded, so a tool never runs inside a call: diag_start puts it in the
// background writing to DIAG/<id>.out (DIAG/<id>.rc when it ends) and the UI polls diag_poll.
const DIAG = '/tmp/er4-diag';
const DIAG_MAX_S = 90;          // watchdog: no job outlives this
let diag_seq = 0;

function host_ok(h) {
	// a name or an address; never starts with '-', so it can't become an option
	return type(h) == 'string' && match(h, /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/) != null;
}

function diag_cmd(a) {
	const h = a.host, six = a.family == 6;
	if (!host_ok(h)) return null;
	switch (a.tool) {
	case 'ping':
		const n = type(a.count) == 'int' && a.count >= 1 && a.count <= 50 ? a.count : 5;
		return `${six ? 'ping6' : 'ping'} -c ${n} -W 2 ${q(h)}`;
	case 'traceroute':
		return `${six ? 'traceroute6' : 'traceroute'} -n -q 1 -w 2 -m 20 ${q(h)}`;
	case 'nslookup':
		if (a.server != null && !host_ok(a.server)) return null;
		return a.server != null ? `nslookup ${q(h)} ${q(a.server)}` : `nslookup ${q(h)}`;
	}
	return null;
}

function diag_id_ok(id) {
	return type(id) == 'string' && match(id, /^[0-9a-f]{1,16}$/) != null;
}

// Forget jobs older than 10 minutes; count the ones still running
function diag_sweep() {
	mkdir(DIAG);
	let running = 0;
	for (let f in lsdir(DIAG) ?? []) {
		const st = stat(`${DIAG}/${f}`);
		if (st && st.mtime < time() - 600) unlink(`${DIAG}/${f}`);
		else if (match(f, /\.pid$/) && !stat(`${DIAG}/${replace(f, /\.pid$/, '.rc')}`)) running++;
	}
	return running;
}

// "Thu Oct 15 12:00:00 2026 [1792087296.123] daemon.info dnsmasq[1234]: message" (logread -t)
// The saved log file (logread -F) has no [epoch]: the ctime date is all there is.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function parse_logread(line) {
	let m = match(line, /^[^ ]+ [^ ]+ +[0-9]+ [0-9:]+ [0-9]+ \[([0-9]+)\.([0-9]+)\] ([a-z0-9]+)\.([a-z]+) (.*)$/);
	let time;
	if (m) time = +m[1] + +m[2] / 1000.0;
	else {
		const d = match(line, /^[^ ]+ ([A-Z][a-z]{2}) +([0-9]+) ([0-9]+):([0-9]+):([0-9]+) ([0-9]+) ([a-z0-9]+)\.([a-z]+) (.*)$/);
		if (!d) return { msg: line };
		time = timelocal({ year: +d[6], mon: MONTHS[d[1]] ?? 1, mday: +d[2], hour: +d[3], min: +d[4], sec: +d[5] });
		m = [ null, null, null, d[7], d[8], d[9] ];
	}
	const t = match(m[5], /^([^: ]+): ?(.*)$/);
	return { time, facility: m[3], level: m[4], tag: t ? t[1] : null, msg: t ? t[2] : m[5] };
}

// "<6>[   12.345678] message" (busybox dmesg -r): seconds since boot
function parse_dmesg(line) {
	const m = match(line, /^(<([0-9]+)>)?\[ *([0-9]+\.[0-9]+)\] ?(.*)$/);
	if (!m) return { msg: line };
	const LEVELS = [ 'emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug' ];
	return { uptime: +m[3], level: m[2] != null ? LEVELS[+m[2] % 8] : null, msg: m[4] };
}

// One `conntrack -L -o extended` line:
// "ipv4 2 tcp 6 431999 ESTABLISHED src=A dst=B sport=1 dport=2 [packets= bytes=] src=B dst=C sport=2 dport=1 [ASSURED] mark=0 use=1"
// The first src/dst/sport/dport (and packets/bytes) are the original direction, the second the reply.
function parse_ct(line) {
	const f = split(trim(line), /[ \t]+/);
	if (length(f) < 6 || (f[0] != 'ipv4' && f[0] != 'ipv6')) return null;
	const c = { family: f[0] == 'ipv6' ? 6 : 4, proto: f[2], timeout: +f[4], flags: [] };
	const o = {}, r = {};
	for (let i = 5; i < length(f); i++) {
		const kv = match(f[i], /^([a-z_]+)=(.*)$/);
		if (kv) {
			const d = (kv[1] in o && index([ 'src', 'dst', 'sport', 'dport', 'packets', 'bytes', 'type', 'code', 'id' ], kv[1]) >= 0) ? r : o;
			d[kv[1]] = kv[2];
		}
		else if (match(f[i], /^\[[A-Z_]+\]$/))
			push(c.flags, substr(f[i], 1, length(f[i]) - 2));
		else if (i == 5 && match(f[i], /^[A-Z_]+$/))
			c.state = f[i];
	}
	c.src = o.src; c.dst = o.dst; c.reply_src = r.src; c.reply_dst = r.dst;
	if (o.sport != null) { c.sport = +o.sport; c.dport = +o.dport; c.reply_sport = +r.sport; c.reply_dport = +r.dport; }
	if (o.bytes != null) { c.bytes = +o.bytes; c.packets = +o.packets; c.reply_bytes = +r.bytes; c.reply_packets = +r.packets; }
	if (o.mark != null && o.mark != '0') c.mark = o.mark;
	if (o.helper != null) c.helper = o.helper;
	return c;
}

// The offload module's live flows (/proc/cavium/flows, our module addition), keyed by the
// tuple the packets arrive with, so a conntrack entry's original and reply tuples look up
// its two directions. Line: "family proto in out src sport dst dport tx_src tx_sport tx_dst tx_dport vlan age_ms"
const IPPROTO = { '6': 'tcp', '17': 'udp' };
function offload_flows() {
	const raw = readfile('/proc/cavium/flows');
	if (raw == null) return null;
	const m = {};
	for (let l in split(raw, '\n')) {
		const f = split(trim(l), ' ');
		if (length(f) < 14) continue;
		m[`${IPPROTO[f[1]] ?? f[1]} ${f[4]} ${f[5]} ${f[6]} ${f[7]}`] = { in: f[2], out: f[3], age: +f[13] };
	}
	return m;
}

// "[options ]type base64[ comment]"; dropbear takes these key types
const AUTH_KEYS = '/etc/dropbear/authorized_keys';
const KEY_TYPES = [ 'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
	'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com' ];
function parse_key(l) {
	if (!length(l) || substr(l, 0, 1) == '#') return null;
	const f = split(l, /[ \t]+/);
	// options come first and may hold quoted spaces (command="..."), so look for the type anywhere
	for (let i = 0; i < length(f); i++) {
		if (index(KEY_TYPES, f[i]) >= 0 && i + 1 < length(f) && match(f[i + 1], /^[A-Za-z0-9+\/]+={0,3}$/))
			return { line: l, type: f[i], key: f[i + 1], comment: join(' ', slice(f, i + 2)) || null, options: i ? join(' ', slice(f, 0, i)) : null };
	}
	return null;
}

function read_keys() {
	const keys = [];
	for (let l in split(readfile(AUTH_KEYS) ?? '', '\n')) {
		const k = parse_key(trim(l));
		if (k) push(keys, k);
	}
	return keys;
}

function ip_json(args) {
	return json(sh(`ip -j ${args} 2>/dev/null`) || '[]') ?? [];
}

// ---- processes (er4.processes / er4.kill) --------------------------------------------------
// CPU % is the share of the whole machine (4 cores = 100 %) since the previous call (the page
// polls); the first call has nothing to compare with and reports null.
const PS_PREV = '/tmp/er4-ps.json';
function cpu_total() {
	const m = match(readfile('/proc/stat') ?? '', /^cpu +([0-9 ]+)/);
	let t = 0;
	for (let x in split(trim(m?.[1] ?? ''), / +/)) t += +x;
	return t;
}
function users() {
	const u = {};
	for (let l in split(readfile('/etc/passwd') ?? '', '\n')) {
		const f = split(l, ':');
		if (length(f) > 2) u[f[2]] = f[0];
	}
	return u;
}

// ---- packet capture (er4.capture_*) -----------------------------------------------------------
const CAP = '/tmp/er4-capture.pcap';
const CAP_PID = '/tmp/er4-capture.pid';
const CAP_LOG = '/tmp/er4-capture.log';
function cap_running() {
	const pid = +trim(readfile(CAP_PID) ?? '0');
	return type(pid) == 'int' && pid > 1 && access(`/proc/${pid}`) ? pid : 0;
}

// ---- crontab (er4.crontab / crontab_set) ------------------------------------------------------
const CRONTAB = '/etc/crontabs/root';
const CRON_FIELD = /^(\*|[0-9]+(-[0-9]+)?)(\/[0-9]+)?(,(\*|[0-9]+(-[0-9]+)?)(\/[0-9]+)?)*$/;
function cron_line_ok(l) {
	l = trim(l);
	if (l == '' || substr(l, 0, 1) == '#') return true;
	const f = split(l, /[ \t]+/);
	if (length(f) < 6) return false;
	for (let i = 0; i < 5; i++) if (!match(f[i], CRON_FIELD)) return false;
	return true;
}

// ---- Tailscale (er4.tailscale_*) -------------------------------------------------------------
// The binaries are Tailscale's own build on the eMMC, fetched by er4-tailscale-fetch (/usr/sbin
// links there); until then TS doesn't resolve and the UI offers to install it.
const TS = '/usr/sbin/tailscale';
const TS_FETCH = '/tmp/er4-tailscale-fetch';
const TS_UPDATE_LOG = '/tmp/er4-tailscale-update.log';
function ts_job(pidfile) {
	const pid = trim(readfile(pidfile) ?? '');
	return pid != '' && system(`kill -0 ${int(pid)} 2>/dev/null`) == 0;
}
// "downloading" | "ok <version>" | "error <message>" -> {state, message?}, null before the first install
function ts_fetch_state() {
	const t = trim(readfile(TS_FETCH) ?? '');
	if (t == '') return null;
	const m = match(t, /^(\S+) ?(.*)$/);
	return { state: m[1] == 'downloading' && !ts_job('/tmp/er4-tailscale-fetch.pid') ? 'error' : m[1], message: m[2] || (m[1] == 'downloading' ? null : 'interrupted') };
}
function ts_json(args) {
	const out = sh(`${TS} ${args} 2>/dev/null`);
	return length(out) ? json(out) : null;
}
function cidr_ok(c) {
	return type(c) == 'string' && (match(c, /^([0-9]{1,3}\.){3}[0-9]{1,3}\/([0-9]|[12][0-9]|3[0-2])$/) || match(c, /^[0-9a-fA-F:]+\/[0-9]{1,3}$/));
}

// ---- IPsec / IKEv2 (er4.ipsec_*; config is UCI 'ipsec', rendered by /etc/init.d/swanctl) ------
const SWAN = '/etc/swanctl';
// `swanctl --list-sas --pretty`: "name {", "key = value", "key = [", "item", "]", "}" per line
function parse_pretty(text) {
	const root = {}, stack = [ root ];
	let list = null;
	for (let l in split(text, '\n')) {
		l = trim(l);
		if (l == '') continue;
		const top = stack[length(stack) - 1];
		if (list != null) {
			if (l == ']') list = null;
			else push(list, l);
			continue;
		}
		let m;
		if (l == '}') { if (length(stack) > 1) pop(stack); }
		else if ((m = match(l, /^(.+?) \{$/))) {
			// one "list-sa event {" per SA: keep each
			let k = m[1];
			for (let i = 2; k in top; i++) k = `${m[1]}#${i}`;
			const o = {}; top[k] = o; push(stack, o);
		}
		else if ((m = match(l, /^([^ =]+) = \[$/))) { list = []; top[m[1]] = list; }
		else if ((m = match(l, /^([^ =]+) = (.*)$/))) top[m[1]] = m[2];
	}
	return root;
}
function cert_info(path) {
	if (!access(path)) return null;
	const out = sh(`pki --print --in ${q(path)} 2>/dev/null`);
	return {
		subject: trim(match(out, /subject: +"?([^"\n]*)/)?.[1] ?? ''),
		san: map(match(out, /altNames: +([^\n]*)/)?.[1] ? split(match(out, /altNames: +([^\n]*)/)[1], /, */) : [], trim),
		not_after: trim(match(out, /not after +([^\n,]*)/)?.[1] ?? '')
	};
}

const methods = {
	stats: {
		call: function() {
			const s = sample();
			remember(s);
			return s;
		}
	},

	history: {
		args: { window: 300 },
		call: function(req) {
			const r = RINGS[`${req.args?.window ?? 300}`] ?? RINGS['300'];
			return { step: r.step, samples: r.s };
		}
	},

	offload: {
		call: function() {
			const loaded = index(readfile('/proc/modules') ?? '', 'cavium_ip_offload ') >= 0;
			const flag = (p) => num(p) == 1;
			const uci = cursor();
			return {
				loaded,
				ipv4: loaded && flag('/proc/cavium/ipv4/fwd'),
				ipv6: loaded && flag('/proc/cavium/ipv6/fwd'),
				vlan: loaded && flag('/proc/cavium/ipv4/vlan'),
				pppoe: loaded && flag('/proc/cavium/ipv4/pppoe'),
				// collection state isn't readable from /proc/cavium/stats; report the config
				stats: uci.get('offload', 'global', 'stats') == '1',
				cache_size: num('/proc/cavium/ipv4/cache_size') ?? 0,
				fwd_queue_depth: num('/sys/module/octeon_ethernet/parameters/fwd_queue_depth') ?? 0
			};
		}
	},

	neighbors: {
		call: function() {
			const out = [];
			// "IP dev DEV [lladdr MAC] [router] STATE"
			for (let line in split(sh('ip -4 neigh show'), '\n')) {
				const f = split(trim(line), /\s+/);
				if (length(f) < 4 || f[1] != 'dev') continue;
				const ll = index(f, 'lladdr');
				push(out, { ip: f[0], dev: f[2], mac: ll >= 0 ? f[ll + 1] : '', state: f[length(f) - 1] });
			}
			return { neighbors: out };
		}
	},

	firmware_info: {
		call: function() {
			const rel = release();
			return with_p1(() => {
				const img = (path) => { const m = image_meta(path); return m ? { build: build_tag(path), installed: m.installed, size: m.size, md5: m.md5 } : null; };
				const cur = img(`${P1}/vmlinux.64`), prev = img(`${P1}/vmlinux.64.prev`);
				const booted = trim(readfile(BOOTED) ?? '');
				// installed since this boot: vmlinux.64 boots next, .prev is the running image's copy
				const since = booted != '' && cur?.md5 != null && cur.md5 != booted && prev?.md5 == booted;
				const running = { ...(since ? prev : cur ?? { build: null }), version: rel.release };
				return {
					board: trim(readfile('/tmp/sysinfo/board_name') ?? ''),
					channel: null,	// no published releases yet
					running,
					next: since ? cur : null,
					previous: since ? null : prev
				};
			});
		}
	},

	firmware_check: {
		call: function() {
			const rel = release();
			// No release channel yet (local builds only)
			return { current: rel.release, update_available: false, checked: time() };
		}
	},

	firmware_verify: {
		args: { path: '' },
		call: function(req) {
			return verify(req.args.path);
		}
	},

	firmware_install: {
		args: { path: '' },
		call: function(req) {
			const path = req.args.path;
			// one install at a time: a second one would interleave on p1
			if (get_status().state == 'writing') return set_status({ ...get_status() });
			const v = verify(path);
			if (!v.valid) return set_status({ state: 'error', progress: 0, message: 'image failed verification' });
			const sum = v.image.sha256;
			// Background job: keep the running image as .prev, write .new, check, swap.
			// /etc lives on p2 and stays as it is (keep_config is always true here).
			const job = `( mkdir -p ${P1}; grep -q ' ${P1} ' /proc/mounts || mount -t vfat /dev/mmcblk0p1 ${P1} || exit 1
				cd ${P1} && cp -p vmlinux.64 vmlinux.64.prev.tmp && mv vmlinux.64.prev.tmp vmlinux.64.prev && { cp vmlinux.64.md5 vmlinux.64.prev.md5 2>/dev/null || true; } &&
				cp ${q(path)} vmlinux.64.new && sync &&
				[ "$(sha256sum vmlinux.64.new | cut -d' ' -f1)" = ${q(sum)} ] &&
				mv vmlinux.64.new vmlinux.64 && md5sum vmlinux.64 | cut -d' ' -f1 > vmlinux.64.md5 && sync &&
				echo '{"state":"ready","progress":1}' > ${STATUS} ||
				echo '{"state":"error","progress":0,"message":"writing the image failed; the running image is untouched"}' > ${STATUS}
				cd /; umount ${P1} ) >/dev/null 2>&1 &`;
			set_status({ state: 'writing', progress: 0.5, path });
			system(job);
			return get_status();
		}
	},

	firmware_status: {
		call: function() {
			return get_status();
		}
	},

	firmware_download: {
		args: { url: '', path: '' },
		call: function() {
			return set_status({ state: 'error', progress: 0, message: 'no release channel configured yet: upload an image instead' });
		}
	},

	boot_previous: {
		call: function() {
			const r = with_p1(() => {
				if (!stat(`${P1}/vmlinux.64.prev`)) return { error: 'no previous image' };
				system(`cd ${P1} && mv vmlinux.64 vmlinux.64.swap && mv vmlinux.64.prev vmlinux.64 && mv vmlinux.64.swap vmlinux.64.prev && { mv vmlinux.64.md5 vmlinux.64.md5.swap; mv vmlinux.64.prev.md5 vmlinux.64.md5; mv vmlinux.64.md5.swap vmlinux.64.prev.md5; } 2>/dev/null; sync`);
				return {};
			});
			if (!r.error) system('(sleep 2; reboot) >/dev/null 2>&1 &');
			return r;
		}
	},

	// procd's system.reboot starts the shutdown before it answers, so the reply (and the UI's
	// wait screen) can be lost with the network: answer first, reboot two seconds later.
	reboot: {
		call: function() {
			system('(sleep 2; reboot) >/dev/null 2>&1 &');
			return {};
		}
	},

	config_inspect: {
		args: { path: '' },
		call: function(req) {
			const files = filter(split(sh(`tar -tzf ${q(req.args.path)} 2>/dev/null`), '\n'), length);
			if (!length(files)) return { valid: false, files: [], error: 'not a configuration backup (tar.gz)' };
			const host = sh(`tar -xzOf ${q(req.args.path)} etc/config/system 2>/dev/null | sed -n "s/.*option hostname '\\?\\([^']*\\)'\\?/\\1/p" | head -1`);
			return { valid: true, hostname: host || null, files };
		}
	},

	config_restore: {
		args: { path: '' },
		call: function(req) {
			// /etc is the persistent overlay: copying a backup's etc/ into it is the restore.
			// Checked before anything is written: every member under etc/, no '..', no hard links,
			// and nothing below a symlink the archive itself creates (extraction would write
			// through it, e.g. etc/x -> /usr/bin then etc/x/sh).
			const path = req.args.path;
			const list = filter(split(sh(`tar -tvzf ${q(path)} 2>/dev/null`), '\n'), length);
			if (!length(list)) return { error: 'not a configuration backup (tar.gz)' };
			const links = {}, names = [];
			for (let l in list) {
				const arrow = index(l, ' -> ');
				const head = arrow >= 0 ? substr(l, 0, arrow) : l;
				const name = replace(match(head, /([^ ]+)$/)?.[1] ?? '', /^\.\//, '');
				if (substr(l, 0, 1) == 'h' || index(l, ' link to ') >= 0) return { error: `refusing hard link ${name}` };
				if (!match(name, /^etc(\/|$)/) || match(name, /(^|\/)\.\.(\/|$)/)) return { error: `refusing ${name}: only etc/ is restored` };
				if (substr(l, 0, 1) == 'l') links[replace(name, /\/$/, '')] = true;
				push(names, name);
			}
			for (let n in names) {
				const parts = split(replace(n, /\/$/, ''), '/');
				for (let i = 1; i < length(parts); i++)
					if (links[join('/', slice(parts, 0, i))]) return { error: `refusing ${n}: below a symlink in the archive` };
			}
			const stage = '/tmp/er4-restore';
			system(`rm -rf ${stage}; mkdir -p ${stage}`);
			const ok = system(`tar -xzf ${q(path)} -C ${stage} && [ -d ${stage}/etc ] && cp -a ${stage}/etc/. /etc/ && sync`) == 0;
			system(`rm -rf ${stage}`);
			if (!ok) return { error: 'restore failed' };
			system('(sleep 2; reboot) >/dev/null 2>&1 &');
			return {};
		}
	},

	factory_reset: {
		call: function() {
			// Forget everything in the persistent /etc (the image's defaults come back on boot)
			system('(sleep 2; rm -rf /mnt/er4data/er4/etc /mnt/er4data/er4/.etc-work; sync; reboot -f) >/dev/null 2>&1 &');
			return {};
		}
	},

	// The methods below replace the few LuCI backend calls the UI used (luci.setPassword,
	// luci.getTimezones, luci.setLocaltime, luci.wireguard.*), so the image needs no luci-base.

	set_password: {
		args: { username: 'root', password: 'password' },
		call: function(req) {
			const u = req.args.username ?? 'root', p = req.args.password;
			if (!match(u, /^[a-z_][a-z0-9_-]{0,31}$/) || !user_exists(u))
				return { result: false, error: 'unknown user' };
			if (type(p) != 'string' || !length(p) || index(p, '\n') >= 0)
				return { result: false, error: 'bad password' };
			return { result: passwd(u, p) };
		}
	},

	// First-boot setup: the only er4 calls the logged-out session may make
	// (ACL group "unauthenticated"). setup_password works only while root has no password.
	setup_status: {
		call: function() {
			return { password_set: root_has_password() };
		}
	},

	setup_password: {
		args: { password: 'password' },
		call: function(req) {
			const p = req.args.password;
			if (root_has_password()) return { result: false, error: 'a password is already set' };
			if (type(p) != 'string' || length(p) < 8 || index(p, '\n') >= 0)
				return { result: false, error: 'bad password' };
			return { result: passwd('root', p) };
		}
	},

	timezones: {
		call: function() {
			const zones = json(readfile('/usr/share/er4/zoneinfo.json') ?? '{}');
			const active = cursor().get('system', '@system[0]', 'zonename') ?? 'UTC';
			const out = {};
			for (let name, tzstring in zones)
				out[name] = name == active ? { tzstring, active: true } : { tzstring };
			return out;
		}
	},

	set_localtime: {
		args: { localtime: 0 },
		call: function(req) {
			const t = localtime(req.args.localtime);
			if (type(req.args.localtime) != 'int' || !t)
				return { result: false };
			system(sprintf('date -s "%04d-%02d-%02d %02d:%02d:%02d" >/dev/null', t.year, t.mon, t.mday, t.hour, t.min, t.sec));
			system('/etc/init.d/sysfixtime restart >/dev/null 2>&1');
			return { result: req.args.localtime };
		}
	},

	// Same reply shape as luci.wireguard getWgInstances: { <iface>: { name, public_key,
	// listen_port, fwmark, peers: [{ name, public_key, endpoint, allowed_ips, latest_handshake,
	// transfer_rx, transfer_tx, persistent_keepalive }] } }. Peer names come from UCI.
	wg_instances: {
		call: function() {
			const out = {}, names = {};
			const uci = cursor();
			uci.foreach('network', null, (s) => {
				if (substr(s['.type'], 0, 10) == 'wireguard_' && s.public_key)
					names[`${substr(s['.type'], 10)}/${s.public_key}`] = s.description;
			});
			for (let line in split(sh('wg show all dump 2>/dev/null'), '\n')) {
				const f = split(line, '\t');
				if (length(f) == 5) {
					// interface: name, private key, public key, listen port, fwmark
					out[f[0]] = { name: f[0], public_key: f[2], listen_port: f[3], fwmark: f[4], peers: [] };
				}
				else if (length(f) == 9 && out[f[0]]) {
					// peer: iface, public key, psk, endpoint, allowed ips, handshake, rx, tx, keepalive
					push(out[f[0]].peers, {
						name: names[`${f[0]}/${f[1]}`],
						public_key: f[1],
						endpoint: f[3],
						allowed_ips: f[4] == '(none)' || !length(f[4]) ? [] : split(f[4], ','),
						latest_handshake: f[5],
						transfer_rx: f[6],
						transfer_tx: f[7],
						persistent_keepalive: f[8]
					});
				}
			}
			return out;
		}
	},

	// Fallback for browsers without X25519 (the UI generates keys locally when it can)
	wg_keypair: {
		call: function() {
			const priv = sh('wg genkey 2>/dev/null');
			const pub = length(priv) ? sh(`echo ${q(priv)} | wg pubkey 2>/dev/null`) : '';
			return { keys: { priv, pub } };
		}
	},

	// System log (logd's ring buffer) or kernel log (dmesg), newest last.
	// {source: 'system'|'kernel', lines} -> {source, boot, lines: [{time?|uptime?, facility?, level?, tag?, msg}]}
	// boot is the boot time (unix s), to place dmesg's seconds-since-boot on the clock.
	log: {
		args: { source: 'system', lines: 500 },
		call: function(req) {
			const n = type(req.args.lines) == 'int' && req.args.lines > 0 ? min(req.args.lines, 5000) : 500;
			const kernel = req.args.source == 'kernel';
			let raw;
			if (req.args.source == 'saved') {
				// the log file the log service keeps (System > Logging), with its rotated .old first
				const f = cursor().get_first('system', 'system', 'log_file');
				if (!f) return { error: 'no log file configured' };
				raw = sh(`cat ${q(f + '.old')} ${q(f)} 2>/dev/null | tail -n ${n}`);
			}
			else raw = kernel ? sh(`dmesg -r 2>/dev/null | tail -n ${n}`) : sh(`logread -t -l ${n} 2>/dev/null`);
			const up = +split(readfile('/proc/uptime') ?? '0', ' ')[0];
			const lines = [];
			for (let l in split(raw, '\n'))
				if (length(l)) push(lines, kernel ? parse_dmesg(l) : parse_logread(l));
			return { source: kernel ? 'kernel' : req.args.source == 'saved' ? 'saved' : 'system', boot: time() - int(up), lines };
		}
	},

	// Routing tables and neighbours, as `ip -j` prints them (all tables; the UI filters).
	routes: {
		call: function() {
			return {
				ipv4: ip_json('-4 route show table all'),
				ipv6: ip_json('-6 route show table all'),
				neigh: [ ...ip_json('-4 neigh show'), ...ip_json('-6 neigh show') ]
			};
		}
	},

	// WAN health from er4-wanmon (a ping to the gateway and to the internet every 10 s, in /tmp)
	// and WAN up/down events from the iface hotplug hook. {window: seconds (max 86400)} ->
	// {step, target, samples: [{t, gw_rtt, gw_loss, inet_rtt, inet_loss}], events: [{t, action, iface}]}
	// Buckets of `step` seconds: rtt is the mean of the replies (null: none), loss 0..1.
	wan_health: {
		args: { window: 3600 },
		call: function(req) {
			const win = type(req.args.window) == 'int' && req.args.window > 0 ? min(req.args.window, 86400) : 3600;
			const step = max(10, int(win / 720 / 10) * 10 || 10);
			const since = time() - win;
			const b = {};
			for (let l in split(readfile('/tmp/er4-wan.tsv') ?? '', '\n')) {
				const f = split(l, ' ');
				if (length(f) != 3 || +f[0] < since) continue;
				const k = int(+f[0] / step) * step;
				const x = b[k] ??= { n: 0, gw: 0, gwn: 0, in: 0, inn: 0 };
				x.n++;
				if (f[1] != '-') { x.gw += +f[1]; x.gwn++; }
				if (f[2] != '-') { x.in += +f[2]; x.inn++; }
			}
			const samples = [];
			for (let k in sort(keys(b), (p, q) => +p - +q)) {
				const x = b[k];
				push(samples, {
					t: +k,
					gw_rtt: x.gwn ? x.gw / x.gwn : null, gw_loss: (x.n - x.gwn) / x.n,
					inet_rtt: x.inn ? x.in / x.inn : null, inet_loss: (x.n - x.inn) / x.n
				});
			}
			const events = [];
			for (let l in split(readfile('/tmp/er4-wan-events') ?? '', '\n')) {
				const f = split(l, ' ');
				if (length(f) == 3 && +f[0] >= since) push(events, { t: +f[0], action: f[1], iface: f[2] });
			}
			return { step, target: '1.1.1.1', running: system('pidof er4-wanmon >/dev/null 2>&1') == 0, samples, events };
		}
	},

	// SSH keys that may log in as root (dropbear's /etc/dropbear/authorized_keys).
	// -> {keys: [{line, type, comment}]}
	ssh_keys: {
		call: function() {
			return { keys: read_keys() };
		}
	},

	// Replace the key list. {keys: [line, ...]} -> {keys} | {error}. Every line must parse as a
	// public key (options allowed); nothing is written otherwise.
	ssh_keys_set: {
		args: { keys: [ 'line' ] },
		call: function(req) {
			const lines = req.args.keys;
			if (type(lines) != 'array' || length(lines) > 64) return { error: 'bad arguments' };
			const out = [];
			for (let l in lines) {
				if (type(l) != 'string' || index(l, '\n') >= 0 || !parse_key(trim(l)))
					return { error: `not a public key: ${substr(l ?? '', 0, 40)}` };
				push(out, trim(l));
			}
			mkdir('/etc/dropbear');
			const tmp = `${AUTH_KEYS}.new`;
			if (!writefile(tmp, length(out) ? join('\n', out) + '\n' : '') ||
			    system(`chmod 600 ${tmp} && mv ${tmp} ${AUTH_KEYS}`) != 0)
				return { error: 'cannot write authorized_keys' };
			return { keys: read_keys() };
		}
	},

	// Restart one interface: `ifup` takes it down and up again (DHCP renews, PPPoE redials).
	// One call on the router, so restarting the network the browser uses still comes back up.
	iface_restart: {
		args: { name: 'lan' },
		call: function(req) {
			const n = req.args.name;
			if (type(n) != 'string' || n == 'loopback' || !match(n, /^[A-Za-z0-9_]{1,15}$/) ||
			    cursor().get('network', n) != 'interface')
				return { error: 'no such interface' };
			system(`(sleep 1; ifup ${n}) </dev/null >/dev/null 2>&1 &`);
			return {};
		}
	},

	// The connection tracking table (conntrack-tools, over netlink: the kernel has no
	// /proc/net/nf_conntrack). {limit} -> {count, max, flows: [...]} (see parse_ct)
	conntrack: {
		args: { limit: 2000 },
		call: function(req) {
			const n = type(req.args.limit) == 'int' && req.args.limit > 0 ? min(req.args.limit, 10000) : 2000;
			const flows = [];
			const fast = offload_flows();
			for (let l in split(sh(`conntrack -L -o extended 2>/dev/null | head -n ${n}`), '\n')) {
				const c = parse_ct(l);
				if (!c) continue;
				if (fast && c.sport != null) {
					const o = fast[`${c.proto} ${c.src} ${c.sport} ${c.dst} ${c.dport}`];
					const r = fast[`${c.proto} ${c.reply_src} ${c.reply_sport} ${c.reply_dst} ${c.reply_dport}`];
					if (o || r) c.offload = { orig: o, reply: r };
				}
				push(flows, c);
			}
			const flag = (p) => num(p) == 1;
			return {
				count: num('/proc/sys/net/netfilter/nf_conntrack_count') ?? length(flows),
				max: num('/proc/sys/net/netfilter/nf_conntrack_max') ?? 0,
				// null: no offload module (or an older one without /proc/cavium/flows)
				offload: fast ? { ipv4: flag('/proc/cavium/ipv4/fwd'), ipv6: flag('/proc/cavium/ipv6/fwd') } : null,
				flows
			};
		}
	},

	// What fw4 actually loaded: {ruleset: `nft list ruleset` text, counters: {name: {packets, bytes}}}.
	// fw4 tags every rule it generates with comment "!fw4: <section name>" and a counter; one UCI
	// section can become several nft rules (families, protocols), so they are summed per name.
	firewall_status: {
		call: function() {
			const counters = {};
			const j = json(sh('nft -j list ruleset 2>/dev/null') || '{}');
			for (let o in j?.nftables ?? []) {
				const r = o.rule;
				const m = r ? match(r.comment ?? '', /^!fw4: (.+)$/) : null;
				if (!m) continue;
				for (let e in r.expr ?? []) {
					if (!e.counter) continue;
					const c = counters[m[1]] ??= { packets: 0, bytes: 0 };
					c.packets += e.counter.packets ?? 0;
					c.bytes += e.counter.bytes ?? 0;
				}
			}
			const text = sh('nft list ruleset 2>&1');
			return { ruleset: length(text) > 262144 ? substr(text, 0, 262144) : text, counters };
		}
	},

	// -> {processes: [{pid, ppid, user, state, cpu (% of the machine, null on the first call), rss (KiB), mem (%), command}]}
	processes: {
		call: function() {
			const prev = json(readfile(PS_PREV) ?? '{}') ?? {};
			const total = cpu_total(), dt = total - (prev.total ?? 0);
			const memtotal = +(match(readfile('/proc/meminfo') ?? '', /MemTotal: +([0-9]+)/)?.[1] ?? 0);
			const who = users(), ticks = {}, out = [];
			for (let d in lsdir('/proc') ?? []) {
				if (!match(d, /^[0-9]+$/)) continue;
				const st = readfile(`/proc/${d}/stat`);
				if (!st) continue;
				const r = rindex(st, ')');
				const comm = substr(st, index(st, '(') + 1, r - index(st, '(') - 1);
				const f = split(substr(st, r + 2), ' ');	// f[0] = state (field 3)
				const t = +f[11] + +f[12];	// utime + stime
				ticks[d] = t;
				const status = readfile(`/proc/${d}/status`) ?? '';
				const uid = match(status, /\nUid:\t([0-9]+)/)?.[1];
				const rss = +(match(status, /\nVmRSS:\s+([0-9]+)/)?.[1] ?? 0);
				let cmd = trim(replace(readfile(`/proc/${d}/cmdline`) ?? '', /\x00/g, ' '));
				push(out, {
					pid: +d, ppid: +f[1], state: f[0], user: who[uid] ?? uid, rss,
					mem: memtotal ? rss * 100.0 / memtotal : 0,
					cpu: prev.ticks?.[d] != null && dt > 0 ? (t - prev.ticks[d]) * 100.0 / dt : null,
					command: length(cmd) ? cmd : `[${comm}]`
				});
			}
			writefile(PS_PREV, sprintf('%J', { total, ticks }));
			return { processes: out };
		}
	},

	// {pid, signal: 'HUP'|'TERM'|'KILL'} -> {} | {error}
	kill: {
		args: { pid: 0, signal: 'TERM' },
		call: function(req) {
			const pid = req.args.pid, sig = req.args.signal;
			if (type(pid) != 'int' || pid <= 1 || !(sig in [ 'HUP', 'TERM', 'KILL' ])) return { error: 'bad arguments' };
			if (!access(`/proc/${pid}`)) return { error: 'no such process' };
			return system([ 'kill', `-${sig}`, `${pid}` ]) == 0 ? {} : { error: 'kill failed' };
		}
	},

	// -> {text, enabled (cron starts at boot), running}
	crontab: {
		call: function() {
			return {
				text: readfile(CRONTAB) ?? '',
				enabled: system('/etc/init.d/cron enabled') == 0,
				running: sh('pidof crond') != ''
			};
		}
	},

	// {text} -> {} | {error, line}: writes root's crontab, enables and restarts cron (or stops it when empty)
	crontab_set: {
		args: { text: 'text' },
		call: function(req) {
			const text = req.args.text;
			if (type(text) != 'string' || length(text) > 16384) return { error: 'bad arguments' };
			const lines = split(text, '\n');
			for (let i = 0; i < length(lines); i++)
				if (!cron_line_ok(lines[i])) return { error: 'not a cron line', line: i + 1 };
			mkdir('/etc/crontabs');
			writefile(CRONTAB, length(trim(text)) ? trim(text) + '\n' : '');
			const any = filter(lines, (l) => length(trim(l)) && substr(trim(l), 0, 1) != '#');
			if (length(any)) system('/etc/init.d/cron enable; /etc/init.d/cron restart >/dev/null 2>&1');
			else system('/etc/init.d/cron stop >/dev/null 2>&1; /etc/init.d/cron disable');
			return {};
		}
	},

	// {iface, filter?, seconds (≤ 300), packets (≤ 200000)} -> {} | {error}
	// tcpdump into /tmp (RAM), at most 20 MB; read back with cgi-download (er4.acl.json).
	// Offloaded flows skip the kernel after their first packets, so tcpdump doesn't see them.
	capture_start: {
		args: { iface: 'iface', filter: 'filter', seconds: 30, packets: 10000 },
		call: function(req) {
			const a = req.args;
			if (cap_running()) return { error: 'a capture is already running' };
			if (type(a.iface) != 'string' || !match(a.iface, /^[A-Za-z0-9._-]{1,15}$/) || (a.iface != 'any' && !access(`/sys/class/net/${a.iface}`)))
				return { error: 'no such interface' };
			const flt = a.filter ?? '';
			if (type(flt) != 'string' || length(flt) > 200 || !match(flt, /^[]A-Za-z0-9 .:\/()!&|=<>[_-]*$/) || substr(trim(flt), 0, 1) == '-')
				return { error: 'bad filter' };
			const secs = type(a.seconds) == 'int' && a.seconds >= 1 && a.seconds <= 300 ? a.seconds : 30;
			const n = type(a.packets) == 'int' && a.packets >= 1 && a.packets <= 200000 ? a.packets : 10000;
			unlink(CAP);
			// stop at the packet count (tcpdump), the time limit or 20 MB (this loop), whichever comes first
			const job = `tcpdump -i ${q(a.iface)} -n -s 0 -c ${n} -w ${CAP}${length(trim(flt)) ? ' ' + q(trim(flt)) : ''} >${CAP_LOG} 2>&1 & p=$!; ` +
				`echo $p >${CAP_PID}; t=0; while kill -0 $p 2>/dev/null; do ` +
				`[ $t -ge ${secs} ] && kill $p; [ "$(wc -c <${CAP} 2>/dev/null || echo 0)" -gt 20971520 ] && kill $p; sleep 1; t=$((t+1)); done`;
			system(`sh -c ${q(job)} </dev/null >/dev/null 2>&1 &`);
			return {};
		}
	},

	// -> {running, size (bytes), log (tcpdump's messages: "N packets captured", errors)}
	capture_status: {
		call: function() {
			return { running: !!cap_running(), size: stat(CAP)?.size ?? 0, log: trim(readfile(CAP_LOG) ?? '') };
		}
	},

	capture_stop: {
		call: function() {
			const pid = cap_running();
			if (pid) system(`kill ${pid}`);
			return {};
		}
	},

	// -> {installed, install?, enabled, running, version?, latest?, updating?, update_log?, backend?,
	//     auth_url?, tailnet?, self?, peers?, prefs?}
	// backend is tailscaled's BackendState: NeedsLogin, NeedsMachineAuth, Starting, Running, Stopped.
	// install: the download (er4.tailscale_install) {state: downloading|ok|error, message}.
	// latest: the newest release when this one is behind (tailscaled checks; null when current).
	tailscale_status: {
		call: function() {
			const install = ts_fetch_state();
			if (!access(TS)) return { installed: false, install };
			const running = sh('pidof tailscaled') != '';
			const updating = ts_job('/tmp/er4-tailscale-update.pid');
			const log = split(trim(readfile(TS_UPDATE_LOG) ?? ''), '\n');
			const r = { installed: true, install, enabled: system('/etc/init.d/tailscale enabled') == 0, running,
				updating, update_log: log[length(log) - 1] || null };
			// the CLI is a 35 MB binary: only ask it when tailscaled can't say
			r.version = running ? null : split(sh(`${TS} version 2>/dev/null`), '\n')[0] || null;
			if (!running) return r;
			const st = ts_json('status --json');
			const vm = match(st?.Version ?? '', /^[0-9.]+/);
			r.version = vm ? vm[0] : null;
			const p = ts_json('debug prefs');
			if (!st) return r;
			const node = (n) => ({
				name: n.HostName, dns: replace(n.DNSName ?? '', /\.$/, ''), ips: n.TailscaleIPs ?? [], os: n.OS,
				online: !!n.Online, last_seen: n.LastSeen, exit_node: !!n.ExitNode, exit_option: !!n.ExitNodeOption,
				relay: n.Relay, direct: length(n.CurAddr ?? '') > 0, rx: n.RxBytes ?? 0, tx: n.TxBytes ?? 0,
				routes: filter(n.PrimaryRoutes ?? [], (x) => x != '0.0.0.0/0' && x != '::/0')
			});
			const peers = [];
			for (let k, n in st.Peer ?? {}) push(peers, node(n));
			const cv = st.ClientVersion;
			return {
				...r, latest: cv && !cv.RunningLatest ? cv.LatestVersion ?? null : null,
				backend: st.BackendState, auth_url: st.AuthURL || null, tailnet: st.CurrentTailnet?.Name,
				health: st.Health ?? [], self: st.Self ? node(st.Self) : null, peers,
				prefs: p ? { routes: p.AdvertiseRoutes ?? [], exit_node: index(p.AdvertiseRoutes ?? [], '0.0.0.0/0') >= 0,
					accept_routes: !!p.RouteAll, use_exit_node: p.ExitNodeID || null, auto_update: p.AutoUpdate?.Apply === true } : null
			};
		}
	},

	// {} -> {}: download and install Tailscale (er4-tailscale-fetch in the background); progress
	// in tailscale_status.install
	tailscale_install: {
		call: function() {
			system('/usr/libexec/er4-tailscale-fetch </dev/null >/dev/null 2>&1 &');
			return {};
		}
	},

	// {} -> {} | {error}: `tailscale update --yes` in the background (Tailscale's updater: checks
	// the release signature, replaces the binaries, restarts the service)
	tailscale_update: {
		call: function() {
			if (!access(TS)) return { error: 'tailscale is not installed' };
			if (ts_job('/tmp/er4-tailscale-update.pid')) return {};
			system(`sh -c 'echo $$ >/tmp/er4-tailscale-update.pid; exec ${TS} update --yes' </dev/null >${TS_UPDATE_LOG} 2>&1 &`);
			return {};
		}
	},

	// {routes: [cidr], exit_node: bool, accept_routes: bool, auto_update: bool} -> {} | {error}
	// Starts the service; logged in it applies the settings (tailscale set), otherwise it starts a
	// login in the background (tailscale up, then the auto-update setting, which `up` doesn't
	// take) and tailscale_status then carries the auth_url.
	tailscale_up: {
		args: { routes: [], exit_node: false, accept_routes: false, auto_update: true },
		call: function(req) {
			if (!access(TS)) return { error: 'tailscale is not installed' };
			const routes = req.args.routes ?? [];
			if (type(routes) != 'array' || length(routes) > 32 || length(filter(routes, (c) => !cidr_ok(c)))) return { error: 'bad routes' };
			const flags = `--accept-dns=false --advertise-routes=${q(join(',', routes))} ` +
				`--advertise-exit-node=${req.args.exit_node ? 'true' : 'false'} --accept-routes=${req.args.accept_routes ? 'true' : 'false'}`;
			if (sh('pidof tailscaled') == '') {
				system('/etc/init.d/tailscale enable; /etc/init.d/tailscale start');
				// wait (≤ 5 s) for the daemon's socket
				for (let i = 0; i < 5 && !stat('/var/run/tailscale/tailscaled.sock'); i++) system('sleep 1');
			}
			const st = ts_json('status --json');
			const au = `--auto-update=${req.args.auto_update === false ? 'false' : 'true'}`;
			if (st?.BackendState == 'Running') {
				const out = sh(`${TS} set ${flags} ${au} 2>&1`);
				return length(out) ? { error: out } : {};
			}
			system(`sh -c ${q(`${TS} up --reset ${flags} --timeout=600s && ${TS} set ${au}`)} </dev/null >/tmp/er4-tailscale-up.log 2>&1 &`);
			return {};
		}
	},

	// {stop: bool} -> {}: log this router out of the tailnet; stop: also stop and disable the service
	tailscale_logout: {
		args: { stop: false },
		call: function(req) {
			if (!access(TS)) return { error: 'tailscale is not installed' };
			system(`${TS} logout >/dev/null 2>&1`);
			if (req.args.stop) system('/etc/init.d/tailscale stop; /etc/init.d/tailscale disable');
			return {};
		}
	},

	// -> {installed, running, sas: [{name, state, remote_host, remote_id, eap_id, vips, established, children: [...]}],
	//     ca: PEM text (clients install it), server: {subject, san, not_after}}
	ipsec_status: {
		call: function() {
			if (!access('/usr/sbin/swanctl')) return { installed: false };
			const running = sh('pidof charon') != '';
			const sas = [];
			if (running) {
				const tree = parse_pretty(sh('swanctl --list-sas --pretty 2>/dev/null'));
				for (let ev, body in tree) {
					if (!match(ev, /^list-sa event(#[0-9]+)?$/)) continue;
					for (let name, sa in body) {
						const children = [];
						for (let cn, c in sa['child-sas'] ?? {}) push(children, {
							name: c.name ?? cn, state: c.state, local_ts: c['local-ts'] ?? [], remote_ts: c['remote-ts'] ?? [],
							bytes_in: +(c['bytes-in'] ?? 0), bytes_out: +(c['bytes-out'] ?? 0), encr: c['encr-alg']
						});
						push(sas, {
							name, state: sa.state, remote_host: sa['remote-host'], remote_id: sa['remote-id'], eap_id: sa['remote-eap-id'],
							vips: sa['remote-vips'] ?? [], established: +(sa.established ?? 0), encr: sa['encr-alg'], dh: sa['dh-group'], children
						});
					}
				}
			}
			return {
				installed: true, running, sas,
				ca: readfile(`${SWAN}/x509ca/er4-ca.pem`),
				server: cert_info(`${SWAN}/x509/er4-server.pem`)
			};
		}
	},

	// {name} -> {} | {error}: the router's CA (made once) and a server certificate for `name`
	// (its public hostname or address, what clients connect to). ECDSA P-256.
	ipsec_cert: {
		args: { name: 'name' },
		call: function(req) {
			const n = req.args.name;
			if (!access('/usr/bin/pki') && !access('/usr/sbin/pki')) return { error: 'strongswan-pki is not installed' };
			if (type(n) != 'string' || !match(n, /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/)) return { error: 'a host name or IPv4 address' };
			const ca = `${SWAN}/x509ca/er4-ca.pem`, cakey = `${SWAN}/private/er4-ca.key`;
			const key = `${SWAN}/private/er4-server.key`, crt = `${SWAN}/x509/er4-server.pem`;
			system(`mkdir -p ${SWAN}/x509ca ${SWAN}/x509 ${SWAN}/private; chmod 700 ${SWAN}/private`);
			if (!access(ca) || !access(cakey)) {
				if (system(`pki --gen --type ecdsa --size 256 --outform pem >${cakey} && chmod 600 ${cakey} && ` +
					`pki --self --ca --lifetime 3650 --in ${cakey} --type ecdsa --dn "CN=ER-4 VPN CA" --outform pem >${ca}`) != 0)
					return { error: 'making the CA failed' };
			}
			const ip = match(n, /^[0-9.]+$/) != null;
			const rc = system(`pki --gen --type ecdsa --size 256 --outform pem >${key}.new && chmod 600 ${key}.new && ` +
				`pki --pub --in ${key}.new --type ecdsa | pki --issue --lifetime 1825 --cacert ${ca} --cakey ${cakey} ` +
				`--dn ${q('CN=' + n)} --san ${q(n)}${ip ? ' --san ' + q('@' + n) : ''} --flag serverAuth --flag ikeIntermediate --outform pem >${crt}.new && ` +
				`mv ${key}.new ${key} && mv ${crt}.new ${crt}`);
			if (rc != 0) { system(`rm -f ${key}.new ${crt}.new`); return { error: 'issuing the certificate failed' }; }
			system('/etc/init.d/swanctl enabled && /etc/init.d/swanctl reload >/dev/null 2>&1');
			return {};
		}
	},

	// {tool: 'ping'|'traceroute'|'nslookup', host, family?: 4|6, count?, server?} -> {id}
	diag_start: {
		args: { tool: 'ping', host: 'host', family: 4, count: 5, server: 'server' },
		call: function(req) {
			const cmd = diag_cmd(req.args);
			if (!cmd) return { error: 'bad arguments' };
			if (diag_sweep() >= 3) return { error: 'too many tools running' };
			const id = sprintf('%x%x', time(), diag_seq++ % 4096);
			const f = `${DIAG}/${id}`;
			const job = `${cmd} >${f}.out 2>&1 & p=$!; echo $p >${f}.pid; ` +
				`(sleep ${DIAG_MAX_S}; kill $p) 2>/dev/null & w=$!; wait $p; rc=$?; kill $w 2>/dev/null; echo $rc >${f}.rc`;
			system(`sh -c ${q(job)} </dev/null >/dev/null 2>&1 &`);
			return { id };
		}
	},

	// {id} -> {output, done, code?}; output is the last 64 KB
	diag_poll: {
		args: { id: 'id' },
		call: function(req) {
			const id = req.args.id;
			if (!diag_id_ok(id) || !stat(`${DIAG}/${id}.pid`) && !stat(`${DIAG}/${id}.out`))
				return { error: 'no such job' };
			const out = readfile(`${DIAG}/${id}.out`) ?? '';
			const rc = readfile(`${DIAG}/${id}.rc`);
			return {
				output: length(out) > 65536 ? substr(out, -65536) : out,
				done: rc != null,
				code: rc != null ? +trim(rc) : null
			};
		}
	},

	diag_stop: {
		args: { id: 'id' },
		call: function(req) {
			const id = req.args.id;
			const pid = diag_id_ok(id) ? +trim(readfile(`${DIAG}/${id}.pid`) ?? '') : 0;
			if (type(pid) == 'int' && pid > 1) system(`kill ${pid} 2>/dev/null`);
			return {};
		}
	}
};

return { er4: methods };
