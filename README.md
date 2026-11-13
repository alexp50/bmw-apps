# AlexP50 BMW iDrive 7 Apps

Full-screen apps for BMW MGU / iDrive 7, packaged for [Robert Nisipeanu's MGU Store](https://github.com/robertnisipeanu/mgu-store).

## Install from the Store

1. Open **Store** in iDrive.
2. Open **Settings** and choose **Add source**.
3. Enter `alexp50/bmw-apps`.
4. Choose **Releases** as the source type.
5. Refresh sources, then install or update the apps you want.

The release catalog includes the shared GPU renderer and controller gate. Waze HUD and Night Vision Cluster also require `cluster-render` and, for Waze, `waze-on-cluster` from `robertnisipeanu/idrive-apps`. Vehicle Network requires `mgu-python` from the MGU Store source.

## Apps

| App | Package | Purpose |
| --- | --- | --- |
| Ambient Studio | `ambient_studio_full` | Drive-mode ambient colours and rate-limited lighting alerts. Writes only the selected ambient-light colour. |
| DPF Monitor | `dpf_monitor` | Read-only soot, current regeneration progress, next-regeneration time/distance estimate, temperatures, pressure and history. |
| Drive HUD | `drive_hud_full` | HUD turn arrows, Sport gear/RPM/shift lights and engine warm-up information. |
| Green Light Alert | `green_light_alert` | Watches the KAFAS traffic-light camera provider and BMW's validated display signal for red-to-green transitions. Experimental on region-restricted cars. |
| Hotspot Studio | `hotspot_studio` | Shares the Huawei LTE uplink through BMW's hotspot. A parked-only Coding Gateway temporarily grants one selected client access to the ZGW. |
| Night Vision Cluster | `front_camera_cluster` | Projects BMW Night Vision or the parking camera surface into the cluster. Experimental and limited to low speed. |
| Parking & Clearance | `parking_clearance` | Read-only PDC distances, steering tracks and suspension stance. |
| Ride Height Studio | `ride_height` | Requests the factory VDP Standard or High state and keeps a measured-height plan. Parked use only. |
| Road Trip Computer | `road_trip_computer` | Trip history, fuel use, price per litre, trip cost, range, temperature and elevation. Uses its own ID and does not replace Live Data or M Vitals. |
| Start/Stop Insight | `start_stop_insight` | Read-only current/recent Start/Stop inhibition states and available electrical-load channels. |
| Telemetry Studio | `telemetry_studio` | Read-only engine, thermal, tyre, chassis and xDrive telemetry. |
| Vehicle Health Center | `vehicle_health` | Read-only tyres, fluids, service, Check Control, DPF and current faults. |
| Vehicle Network | `vehicle_network` | Passive MGU network inventory and ENET laptop IPv4 guidance. |
| Waze HUD | `waze_hud` | Controls CarPlay map placement and perspective in the HUD. |
| xDrive Studio | `xdrive_studio` | Read-only xDrive torque distribution, wheel slip and chassis dynamics. |

## BMW hotspot Internet and ENET

Hotspot Studio uses explicit userspace services because the O18 MGU kernel has
no NAT support. After enabling Internet sharing in the app, hotspot clients can
use the HTTP proxy at `172.16.222.97:3128` or SOCKS5 at
`172.16.222.97:1088`. This leaves the Huawei uplink isolated from vehicle
networks.

For ISTA or E-Sys, park the car, select the laptop in Hotspot Studio and start a
timed **Coding Gateway** session. On the laptop run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tools\Use-BMW-Hotspot-Gateway.ps1"
```

The script verifies all three endpoints, configures Windows Internet access,
and points ISTA/EDIABAS at the guarded ENET relay. It saves the previous
settings first. Restore them with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tools\Use-BMW-Hotspot-Gateway.ps1" -Mode Restore
```

## Parked BMW for Android

`android/parked-bmw` is a separate Android dashboard for the `remote-telemetry-bridge` MGU tool. While the car is awake, it uploads timestamped cabin temperature, outside temperature, IBS-measured 12 V battery voltage, charge condition, speed, tyre pressures and authoritative IHKA climate state through the installed LTE uplink. Authenticated commands control normal or parked climate, temperature, blower, defrost and four-seat heating/ventilation, then wait for BMW state confirmation. When the car sleeps, the phone shows the retained final snapshot and its age instead of labelling stale data as live. Webasto continues independently after the MGU shuts down; controlling it during full sleep requires an always-powered external gateway or BMW's OEM backend.

The car has a write/execute relay token and the Android app has separate read and command tokens. The app does not collect vehicle location. The GitHub workflow publishes a signed installable APK release.

All app dashboards request the full iDrive canvas and use the 60 fps GPU renderer. Unsupported or stale readings are left blank rather than invented.

The iDrive knob, press and directional push are shared by every app through the Controller gate from the Store's default `cauliflowermossgrape/idrive7-apps` source. After installing or updating that tool, restart the head unit once so `mgu-inputgate.so` loads with the HMI. If the touchscreen works but the controller does not, run `tools/Repair-MGU-Controller.ps1`; it checks the preload, boot guard and competing renderer without changing ECU coding.

On some ID7 units the digital-video surface `0x198` remains marked visible even when it has no buffer. Older `mgu-render` builds then yield every custom-app layer to that empty surface, so unrelated apps all open blank. Run `tools/Repair-MGU-Rendering.ps1`; it excludes only that empty surface in the persistent local renderer configuration and restarts the renderer service without restarting the HMI or changing ECU coding.

## Build and validate

```powershell
python kit/tools/build.py ambient_studio_full dpf_monitor drive_hud_full front_camera_cluster green_light_alert hotspot_studio parking_clearance ride_height road_trip_computer start_stop_insight telemetry_studio vehicle_health vehicle_network waze_hud xdrive_studio
node kit/tools/test_controller.js
python tools/build_components.py
python tools/prepare_release.py
```

The GitHub workflow publishes every artifact in `packages/`, plus `catalog.json`, `mgu-store.json`, and the app icons, as a Store-compatible release.

## Safety and scope

These are unofficial enthusiast apps and are not affiliated with BMW. Diagnostic dashboards are read-only unless their description explicitly says otherwise. Use visual apps while parked or let a passenger operate them. Ride Height Studio exposes BMW's Low, Standard and High preset requests; it does not perform ISTA ride-height calibration or direct individual-strut actuation.

## License

The application kit is MIT licensed; retained third-party files and binaries keep the licences shipped beside them.
