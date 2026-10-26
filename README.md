# luci-app-airoha

Standalone LuCI feed for Airoha/Gemtek firmware builds.

## Packages

- `luci-app-airoha-npu`: Airoha NPU and PPE status, controls, and diagnostics.
- `luci-app-airoha-factory`: factory identity and calibration helpers.
- `luci-app-airoha-recovery`: U-Boot HTTP recovery controls.
- `luci-app-airoha-fancontrol`: fan speed, temperature, and curve controls.
- `luci-app-netmode`: network mode and backhaul status controls.
- `luci-app-mesh-conf`: mesh and wired backhaul configuration.
- `luci-app-clients`: Net Clients status - addresses with their assignment
  source, per-device LAN/WAN traffic, wireless association, DNS query records;
  works on routers and on bridging devices (AP mode) via bridge-port counters
  and passive DHCP/ND snooping.

## OpenWrt / ImmortalWrt feed

Add this feed to `feeds.conf.default`:

```text
src-git airoha https://github.com/naoki66/luci-app-airoha.git
```

Then install the packages with:

```sh
./scripts/feeds update airoha
./scripts/feeds install -a -p airoha
```

The package names and configuration symbols are unchanged so existing device
profiles can continue selecting them after the feed is installed.

## Scope

This repository contains only the seven LuCI packages above. Device trees,
target support, board defaults, firmware images, and private reverse-engineering
material remain in the corresponding firmware repositories.
