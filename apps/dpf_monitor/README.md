# DPF Monitor

An experimental, strictly read-only diesel particulate filter monitor for BMW MGU ID7.

## What it reads

- DPF soot mass from DID `44BE`, with simulated and corrected channels retained for comparison
- exhaust temperature before the DPF
- DPF differential pressure
- coolant temperature from the native vehicle signal
- regeneration request and status codes
- estimated regeneration progress, time remaining and distance remaining
- estimated driving time and distance until the next regeneration starts
- distance, time and fuel since the last successful regeneration
- average regeneration interval and stored successful-regeneration count
- oil ash mass and BMW CBS remaining service distance

The app identifies the DDE with UDS `22 F1 50` at address `0x12`. The reviewed catalog covers D70BX7A0, D75BX7A0 and D83BX7C0. These definitions come from the public EdiabasX SGBD documentation and are kept as a small reviewed subset in `catalog.js`.

## Safety model

The reader uses `kit/runtime/readonly-diag.js`. That transport accepts only read operations and rejects diagnostic sessions, resets, DTC clearing, security access, dynamic identifiers, writes, I/O controls, routines and downloads before they can reach the car. The app never forces a regeneration and never resets learned DPF or CBS values.

“ACTIVE · INFERRED” is intentionally labelled as an inference. It requires a fresh, hot pre-DPF temperature and a falling `44BE` soot trend; it is not presented as an authoritative BMW state. DID `44BB` remains visible only as a raw request/reason code because value `1` has not been verified as a boolean request state on D83BX7C0.

Live fields reject saved or samples older than 15 seconds. The reader polls live DIDs in a fair round-robin order so temperature DIDs cannot be starved by earlier soot requests.

The regeneration estimate is also deliberately labelled. When an active regeneration is inferred, the app records its starting soot mass, fits the recent soot change in grams per minute, and integrates the vehicle-speed signal. Progress is measured from the starting soot value to the configurable end-soot target (6 g by default). Remaining time comes from the observed burn rate; remaining distance uses that time and the session's average moving speed. Until enough samples exist it says `CALIBRATING`. The target is an estimate, not a DDE command or BMW service threshold.

The next-regeneration projection uses the DDE's learned average regeneration interval (`44C7`), distance since the last successful regeneration (`44BF`) and operating time since that regeneration (`44B7`). Remaining distance is the unused part of the learned interval. Driving time uses the average road rate observed over the current interval. It is not calendar time and it cannot account in advance for changing soot load, temperature or driving conditions. During an active regeneration the following cycle remains deliberately unestimated until the current one finishes and the DDE counters reset.

## Build and preview

```powershell
python kit/tools/build.py dpf_monitor
node kit/tools/preview.js dpf_monitor --demo on
```

Use Settings → Demo data → Always to inspect the UI without a car.
