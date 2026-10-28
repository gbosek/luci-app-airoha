# luci-app-clients

One LuCI application for everything the router knows about the stations on its
network: addresses, per-device WAN traffic, the wireless association each
station had, and the DNS lookups it made.

Menu entry: **Status → Net Clients** (`admin/status/clients`), sitting right
after Airoha Soc (`order` 16).

Three tabs:

| Tab | Answers |
|---|---|
| **Overview** | How much total traffic, plus a live trend chart |
| **Devices** | One row per client: addresses with their source, network, WAN rate, connections, last seen (the Signal column only appears on devices with radios) |
| **DNS** | Every lookup dnsmasq answered, with the device that asked and the server it went to |

## Dependencies

Declared in the Makefile, so a normal install pulls them in:

| Package | Why |
|---|---|
| `ucode`, `ucode-mod-fs`, `ucode-mod-ubus` | the two collector scripts |
| `rpcd-mod-iwinfo` | the `iwinfo` ubus object the probe calls for association data |

The vendor-icon bundle (`htdocs/.../resources/clients-oui/`, 501 KB, 67 files)
ships inside this package. It used to live in luci-app-onu and this page merely
borrowed it; that made the icons silently disappear when the other package was
not installed.

## Where the data comes from

Two collectors run on a timer and write to `/tmp`. The pages read those files;
nothing here starts a measurement, and nothing polls a daemon over a socket.

| Source | Provides | Written by |
|---|---|---|
| `nf_conntrack` accounting | per-device rates, LAN/WAN split, connection count | `clients-probe` |
| ARP + IPv6 neighbour cache | who is reachable now, address family | `clients-probe` |
| `iwinfo` assoclist | SSID, band, signal, noise | `clients-probe` |
| bridge snooping | IPv4 assignment evidence, IPv6 addresses learned from neighbour discovery | `clients-snoop`, long-running |
| live snapshot | everything above, with the counters already turned into rates and running totals | `clients-probe collect`, every 10 s |
| archive | first / last seen, last known association and name | `clients-probe collect`, every 30 s |
| dnsmasq query log | DNS records with response time and result | `clients-dns collect`, every 10 s |

The sampling clock belongs to the collector, not to the browser: every pass
walks conntrack once and writes `/tmp/clients-snapshot.json`, with `rates`,
`totals` and the `rate_window` they were divided by, plus one `trend` point
(the summed LAN/WAN rates and, on a routed box, the busiest eight devices). The
series holds 180 points - 30 minutes at the default cadence, enough for the
widest window the page offers - so the chart is already drawn from history when
the page opens instead of filling in from the moment someone looks. Opening the
page reads that file, so a second tab costs nothing and a viewer never waits for
a sample.
`clients-probe` with no argument still prints a live snapshot and exits, and the
page falls back to it - differencing the counters locally - when the file is
missing because the service is stopped.

### What the LAN figure counts

The three tiles on the overview page are LAN, WAN and Total, where Total is the
sum of the other two. Both halves come from conntrack accounting, split by the
far-end address of each flow: an address inside a LAN subnet is LAN, anything
else is WAN.

Two clients on the **same** subnet never appear in that LAN figure. Their frames
are forwarded by the bridge at layer 2, so no conntrack entry is ever created and
no counter the kernel exposes for this purpose moves. On a routed box with a
single LAN subnet the LAN tile therefore has nothing to report, and it shows an
em dash instead of `0 B/s` - a zero would suggest the figure is measured and
happens to be idle. It turns into real numbers as soon as traffic crosses between
LAN subnets, which is the only LAN traffic conntrack can see.

On a bridge (an AP), where the box switches rather than routes, the figures come
from the hardware port counters instead: WAN is the uplink port, LAN is the sum
of the remaining member ports. Those counters do see client-to-client traffic,
so the LAN tile is meaningful there.

The archive merge rides on the same pass but on a slower clock
(`clients.global.interval`), and the stamp that decides it lives in the live
file, so the loop needs no other state.

## Bridging device (AP mode)

When this box only bridges - an AP without its own DHCP server - two of the
page's sources go dark: there are no local leases to colour an IPv4 address
with, and the kernel never resolves a client's global IPv6 address (the box
itself has none, so `ip -6 neigh` only lists the upstream routers). Verified
on a real AP: the IPv6 column stays empty for every client.

`clients-snoop` listens instead. It runs `tcpdump` on the LAN bridge with a
kernel BPF filter that only lifts DHCPv4 and ICMPv6 neighbour-discovery
packets out of the traffic stream, and reduces them to mac → address facts:

- a **DHCPACK** names the client hardware address and the address assigned,
  which colours the IPv4 address as DHCP-assigned even though the server is
  elsewhere;
- a **neighbour advertisement** announces one of the sender's own addresses,
  and a **duplicate-address detection probe** (a solicitation from `::`)
  does the same for the sender - either yields the IPv6 addresses the page
  could not learn otherwise.

Facts land in `/tmp/clients-snoop.json`; `clients-probe` folds them into its
snapshot and marks observations from the last two minutes as live traffic.
The daemon is optional: without `tcpdump` it stays off and the page falls
back to what ARP sees. On a router that owns its DHCP server it adds nothing
the lease file does not already say, so `clients.config.snoop.enabled`
switches it off.

## Why not bandix

`luci-app-bandix` measures traffic in eBPF at the TC hook, which is more precise
than reading conntrack. It also requires the flow offload to be turned off,
because offloaded flows never reach the TC hook. On a PON gateway that trades
hardware line-rate forwarding for a nicer number on a status page, which is a
bad trade. Everything this package shows is derived from conntrack accounting,
and the driver keeps those counters updated for PPE-offloaded flows - verified
on target before this design was chosen.

A note on what exactly conflicts, since it is easy to conflate: **the conflict
is with the hardware offload (PPE), not with software flow offloading.**
Measured on a device with `flow_offloading=1` and `flow_offloading_hw=1` and the
nft flowtable `flags offload` in effect, conntrack still reported per-device WAN
bytes (3.23 MB up / 1.37 MB down for one client). What genuinely stops working
under hardware offload is anything that has to see the packet: eBPF on the TC
hook, `nft` limit/quota rules, and `tc` shaping. That is why this package does
not offer rate limiting or per-device quotas - they cannot be made reliable
without giving up the offload.

## Long-term counters (removed)

The page used to carry a "This month" column backed by `nlbwmon`. It was
removed together with the per-device LAN column: the live WAN figures answer
the question the table asks, and one fewer background counter is one fewer
thing to configure. `nlbwmon` is no longer a dependency; the `clients-probe
nlbw` query path is still present on the backend but nothing calls it.

## Two limits worth knowing

1. **The running totals are floors, not lifetime totals.** conntrack counters
   belong to a flow; when the flow is reaped, its bytes leave the table with it.
   The rate is accurate, the accumulated figure is "what the collector has seen
   since it started" - it survives a page reload, not a reboot.
2. **DNS records live in memory.** They survive a page reload but not a reboot.
   Logging every query costs a little CPU on a busy resolver. The package turns
   `log-queries` on at install time; `clients.dns.enabled=0` stops the collector
   without touching the dnsmasq setting.

## Configuration

`/etc/config/clients`:

| Option | Default | Meaning |
|---|---|---|
| `clients.global.enabled` | `1` | master switch for the host collector |
| `clients.global.interval` | `30` | seconds between host samples |
| `clients.global.retention` | `7` | days an offline client is kept |
| `clients.global.history_path` | `/tmp/clients-history.json` | archive location |
| `clients.global.live_interval` | `10` | seconds between live snapshot passes |
| `clients.global.snapshot_path` | `/tmp/clients-snapshot.json` | location the pages read |
| `clients.global.max_bytes` | `262144` | byte ceiling per cache file |
| `clients.dns.enabled` | `1` | DNS collector on/off |
| `clients.dns.interval` | `10` | seconds between log passes |
| `clients.snoop.enabled` | `1` | passive bridge listening on/off |

Every cache defaults to `/tmp` deliberately: a status page must not wear the
flash. Point them at persistent storage only if the history has to survive a
reboot - and update `acl.d/luci-app-clients.json` to match the new paths.

## Space used in /tmp

`/tmp` is RAM, so the five files this package keeps there are all capped:
`clients-history.json`, `clients-snapshot.json`, `clients-dns.json`,
`clients-snoop.json` and `clients-ptr.json`. A document that would exceed
`max_bytes` gives up rows before it is written - rates first, then the snooped
hints, then whole client rows, the archive's oldest entries, and the DNS
archive's oldest records - so the worst case is `max_bytes` per file instead of
a function of how many addresses the network handed out. The default of 256 KiB
is several times what a /24 of real clients needs; a `/24` under normal use
costs about 210 KiB in total.

The trend series is the largest single item in the snapshot - about 75 KiB with
eight devices and a full 180 points on a routed box, and about 14 KiB on a
bridge, where there is no per-device series. Under byte pressure it goes last:
first the per-device table is dropped, then the oldest points.

`clients-probe status` prints the size of each file and whether any of them is
over the ceiling, which is the cheapest way to check the cap from the outside.

## A note on dnsmasq

OpenWrt ships `log-facility=/dev/null` inside `/etc/dnsmasq.conf`. A second
`log-facility` from UCI aborts dnsmasq startup with *illegal repeated keyword*,
which takes DNS down for the whole LAN. The postinst comments that line out and
lets UCI own the path; prerm puts it back.

## Licence

Apache-2.0.
