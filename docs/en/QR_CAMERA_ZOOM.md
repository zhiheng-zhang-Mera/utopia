# QR camera zoom

PAIR_STATUS: SYNCHRONIZED
FACT: QR_ZOOM=BOUNDED_AUTOMATIC_SWEEP
FACT: QR_ZOOM_MAX=2X

The embedded offline scanner cycles through 1x, 1.5x and 2x while waiting for a decode, using supported hardware steps and returning to wide view. Continuous focus is requested with the library's hardware fallback. This is a bounded zoom sweep, not QR-location tracking; the whole code still needs to be in view. Unsupported zoom leaves the camera usable at its normal scale. Leaving the scanner cancels scheduled changes.

App-private `scan-camera-events.jsonl` records only timestamps, supported zoom, requested and previously observed ratios, and focus mode. A request alone does not prove hardware application. It contains no frames or decoded material and is reset when the scanner resumes. The camera-negative collector allowlists these diagnostics per trial and waits up to 120 seconds for a rejection. Fresh device observations must be bound to the new APK; previous APK evidence stays historical.

Integration uses the camera-parameter callback of [ZXing Android Embedded 4.3.0](https://github.com/journeyapps/zxing-android-embedded/tree/v4.3.0). Unit checks cover hardware limits, the 2x cap, return to wide view and missing capabilities. Physical zoom and expired-QR results are recorded separately in the acceptance evidence.