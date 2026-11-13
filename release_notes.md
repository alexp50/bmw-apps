# AlexP50 BMW iDrive 7 apps

## Applications
* **Ambient Studio** `0.1.5` — Full-screen drive-mode colours and rate-limited ambient-light alerts
* **DPF Monitor** `0.3.2` — Read-only diesel particulate filter monitor: soot, regeneration progress, temperature, pressure and history
* **Drive HUD** `0.1.6` — Full-screen HUD controls: turn arrows, Sport gear/RPM/shift lights and engine warm-up
* **Night Vision Cluster** `0.2.1` — Full-screen control for BMW Night Vision and parking-camera projection in the instrument cluster
* **Green Light Alert** `0.2.5` — Monitors the raw KAFAS traffic-light camera feed, with BMW's validated display signal as a fallback
* **Hotspot Studio** `0.1.5` — Provides Huawei Internet proxies on BMW's hotspot and opens a timed single-client ENET relay on request
* **Parking & Clearance** `0.1.8` — Read-only PDC distances, steering path and suspension stance for close parking
* **Rear Comfort** `0.5.6` — G12 Executive Lounge control for rear climate, comfort seats, massage, shades and entertainment
* **Ride Height Studio** `0.6.0` — Full-screen VDP presets plus direct front/rear air-spring fill and vent control
* **Road Trip Computer** `1.0.0` — Full-screen trip history with fuel use, fuel price, cost, range, outside temperature and GPS elevation
* **Start/Stop Insight** `0.1.3` — Current and last ten observed Start/Stop inhibition states plus live electrical consumers
* **Telemetry Studio** `0.2.0` — Full-screen categorized live data from powertrain, thermal, chassis, tyre, climate and electrical sensors
* **Vehicle Health Center** `0.1.9` — Read-only overview of tyres, fluids, temperatures, service requirements, Check Control, DPF and current faults
* **Vehicle Network** `0.1.3` — Live map of MGU interfaces, observed vehicle network devices and laptop IPv4 setup
* **Waze HUD** `0.3.0` — Full-screen control for projecting the CarPlay navigation map into the head-up display
* **xDrive Studio** `0.1.5` — Read-only xDrive torque distribution, transfer-case torque, wheel slip and chassis dynamics

## Required tools
* **Night Vision cluster helper** `0.2.1` — Mirrors BMW's protected Night Vision or parking-camera surface into the instrument cluster
* **Hotspot Studio helper** `0.1.7` — Shares the MGU LTE uplink with BMW's hotspot and provides a guarded single-client ENET gateway
* **Remote telemetry bridge** `0.2.20` — Publishes parked-car telemetry and executes short-lived authenticated climate commands through mgu-uplink
* **Vehicle network observer** `0.1.2` — Creates the passive network inventory consumed by the Vehicle Network app
* **Waze HUD controller** `0.3.0` — Applies and persists the Waze HUD geometry selected in the Waze HUD app
