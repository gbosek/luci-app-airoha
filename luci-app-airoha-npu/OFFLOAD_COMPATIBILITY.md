# AN7581 PPE driver compatibility

The PPE page consumes the driver's real debugfs table. It does not decide which
packets are eligible for hardware binding and does not turn conntrack
`OFFLOAD`/`HW_OFFLOAD` flags into PPE `BND` entries.

The naoki AN7581 driver additionally prepares a bridge forwarding path when an
existing driver L2-flow cache entry is missing. Its fallback can bind IPv4/IPv6
hardware subflows, so those entries need not use the `L2B` table format. This is
a driver path, separate from this application's legacy bridge-netfilter sysctl
controls. The ordinary routed L4-flow path remains available.

No extra LuCI switch or bridge-netfilter setting is required to parse this
driver's entries. In particular, the XG2010G VLAN/PPPoE/AP-mode sysctl controls
remain unsupported, and active-WAN protection is retained on other boards.
These controls must not be opened merely to increase the displayed BND count.
The hardware flow-offload switch continues to configure firewall software and
hardware flow offloading; this document does not assert that every separately
implemented driver binding path has been measured to stop with that switch.

## Counter semantics

- `bound` counts all `BND` records, including records beyond the returned row
  limit. It is not the number of conntrack connections or a traffic percentage.
- `IPv4`, `IPv6`, and `L2B` are the exported hardware entry formats, not a
  complete attribution of routed versus bridged traffic.
- Packet and byte counters are decimal strings to retain 64-bit precision.
  Missing counters remain `null`; zero counters do not prove that a flow never
  forwarded a packet.
- This feed's native listing returns at most 1024 rows. The firmware's existing
  observability adapter adds a bounded snapshot and complete paged JSON export;
  neither path may truncate the summary to the returned row count.
- A larger BND count establishes neither greater throughput nor better
  stability. Driver eligibility, lifecycle and the observed workload matter.
- PSE shared-buffer peak is a hardware high-water mark, separate from the
  current occupancy. A failed peak-register read remains `null`, not zero.

The reviewed XG2010G images have identical 1456-62 NPU program/data bytes.
The meaningful change is the host driver binding path. This compatibility
review changes no CPU policy, PHY, DHCP, netifd, device tree or NPU firmware.
It does not establish a cause for the separately reported 10G-port outage.

## Offline regression checks

Run on a Linux host with Python 3, awk and bash:

```sh
python3 tests/test-ppe-compatibility.py
```

To also check the firmware's existing full-export adapter against this feed:

```sh
python3 tests/test-ppe-compatibility.py --actions /path/to/Actions-OpenWrt-AN758X
```

The checks use documentation-only IP addresses and temporary files. They do not
connect to a device or change network settings. They cover counts above the
listing limit, IPv4-formatted bridge subflows, exact 64-bit counters, absent
counter semantics, retained XG2010G sysctl restrictions, and (when supplied)
the firmware adapter's full-export registration and runtime tests.
