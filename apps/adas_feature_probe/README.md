# ADAS Feature Probe

Full-screen live probe for the three BMW controls exposed in iDrive as Acoustic warning, Driveaway prevention and Close Passing Assistant.

The app reads BMW's requested setting, setting availability and FAS ECU state separately. The user-triggered enable action is sent only when BMW reports the setting as `OPERABLE`; unavailable functions are never force-written.
