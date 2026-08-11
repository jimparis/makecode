# Circuit Playground MakeCode status

Last updated: 2026-08-11

This is the operational handoff for the project. Git history contains completed
work; this file tracks the current state, constraints, blockers, and remaining
work. External blockers are in [`BLOCKERS.md`](BLOCKERS.md).

## Goal

Publish one maintainable editor at <https://makecode.jim.sh> for:

- Adafruit Circuit Playground Express (CPX, SAMD21)
- Adafruit Circuit Playground Bluefruit (CPB, nRF52840)

Both boards must support editing, simulation, offline built-in compilation,
safe UF2 download, project persistence/export/import, and board switching that
preserves source. Chrome/Chromium should support WebUSB; Firefox must support
everything except WebUSB. Sharing is hosted on the same origin and must not
depend on Microsoft services.

## Non-negotiable design decisions

- CPX and CPB are the only boards shown.
- Build from the source-controlled `jimparis/pxt` fork at upstream PXT
  `v13.1.5`; do not patch generated/minified JavaScript.
- Built-in firmware and ordinary projects work without Microsoft/GitHub at
  runtime. No telemetry or implicit third-party requests.
- Share records are immutable, anonymous, same-origin, and stored outside the
  versioned application image. GitHub/package access is user-initiated only.
- Production is a versioned, rootless, read-only static-package container.
  Never bind-mount a source checkout over `/site` or the application directory.
- Keep the repositories independent peers with preserved `upstream` remotes;
  they are intentionally not submodules under the current workspace contract.
- CPB application flash is `0x26000..<0xEA000`; the bootloader starts at
  `0xF4000`. Do not relax these bounds.

## Repositories and current heads

| Repository | Role | Current head |
| --- | --- | --- |
| `.` | orchestration, acceptance, deployment | `8ca438b73061` plus pending status update |
| `pxt/` | PXT framework fork | `9d444fc5779f` |
| `pxt-circuit-playground/` | target/editor/simulator | `e12fa5e80cb8` |
| `codal-circuit-playground-bluefruit/` | CPB native runtime | `30d62c331ea2` |
| `Adafruit_nRF52_Bootloader/` | CPB HF2 bootloader | `7836c7cc3d81` |

All have public `jimparis/*` origins; children retain `upstream`. Milestone
commits should be pushed after a relevant gate and secret scan.

## Current production

`makecode.jim.sh` currently serves release
`v0.15.77-alpha.74b4fe5b2d0d`. It provides:

- the unified CPX/CPB editor and polished dark Standard theme;
- exactly two validated built-in firmware caches;
- same-origin project publishing and clean share links;
- release-aware service workers and no implicit external requests;
- a rootless container on `psychosis`, bound to `127.0.0.1:3232`, with Apache
  terminating TLS and a persistent share-data mount.

The site remains an alpha with `X-Robots-Tag: noindex, nofollow`.

## In progress: persistent Firefox project repair

The affected live Firefox profile on `basis` was inspected read-only. Project
source was intact. Two persisted problems combined:

1. An older board switch left CPX-owned `infrared` and redundant shared
   packages at the root of a CPB project.
2. Missing native hash `7189a7...845e` returned the editor HTML shell with HTTP
   200; PXT stored that HTML as firmware with an empty native function table,
   causing the TS9200 shim errors and simulator spinner.

Implemented and pushed:

- PXT normalizes stale board-owned dependencies while preserving source and
  persists the repaired `pxt.json`.
- PXT rejects and replaces HTML-shaped native cache records.
- CPX/CPB-specific packages explicitly mark incompatible compile variants.
- Missing firmware/script paths return 404 instead of the SPA shell.
- Browser acceptance seeds the exact legacy dependency shape and poisoned
  cache and requires automatic recovery.
- The service worker no longer precaches absent/obsolete assets or the removed
  telemetry SDK.

The framework, target, server, native-cache, docs, snippet, board-switch, and
static-package gates pass. The first clean release build correctly caught the
obsolete service-worker precache list before deployment. Rebuild the release,
run both local browsers, deploy, run both public browsers, then confirm the
real `basis` profile repairs itself without clearing site data.

## Remaining work, in order

### 1. Finish and deploy the browser-state repair

- Rebuild with PXT `9d444fc5779f`.
- Pass local Chrome and Firefox acceptance, including poisoned-cache repair.
- Deploy through `ssh makecode@psychosis` using the documented versioned OCI
  handoff; verify image identity, read-only/rootless constraints, share mount,
  loopback binding, and rollback path.
- Pass public Chrome and Firefox acceptance with zero unexpected external
  requests or console errors.
- Reload the existing project on `basis`; confirm its dependencies and native
  cache are repaired and the CPB simulator starts. Do not delete the profile or
  clear all site data.

### 2. CPB hardware/runtime acceptance

- Install and test the unofficial HF2-capable CPB bootloader; retain UF2, USB
  DFU, and recovery paths.
- Validate application-to-bootloader handoff, WebUSB reconnect, bounded flash
  reads/writes, repeated partial/full flashes, invalid UF2 rejection, and SWD
  recovery.
- Diagnose the intermittent cold-boot speaker issue on hardware rather than
  assuming PWM is the cause. Run 50 cold boots after the fix.
- Test buttons, slide switch, pixels, accelerometer, temperature, light,
  microphone/loudness, analog/digital I/O, serial, and repeated music. CPB
  touch and storage remain disabled until native support exists.

### 3. Cross-browser and physical-device acceptance

- Run 25 WebUSB upload/run cycles per board in Linux Chrome/Chromium and
  Chromebook Chrome; verify UF2 fallback and reconnect behavior.
- Manually confirm Firefox persistence, simulator, export/import, and UF2.
- Review theme hover/focus/disabled states and color-picker placement on the
  actual Chromebook and Linux desktop.
- Verify CPX hardware, including infrared, after the unified-site changes.

### 4. Product and operations cleanup

- Finish shared capability APIs and kid-friendly starter projects.
- Remove remaining unused Maker assets and resolve useful `missing in sim`
  diagnostics where practical.
- Add the production share directory to normal backups.
- Install/test narrow Linux udev rules for CPX/CPB WebUSB.
- Add GitHub Actions and optional GHCR publication with pinned builders and no
  PR secrets. Keep local reproducibility as the source of truth.
- Triage inherited npm vulnerabilities deliberately; never use
  `npm audit fix --force` as a blanket upgrade.

### 5. Public v1

- Seek appropriate upstream/Adafruit review for the unofficial CPB bootloader
  and USB identity use.
- Remove `noindex` and add final immutable-asset caching only after the full
  hardware/browser matrix passes.
- Document the supported recovery path and clearly label unofficial firmware.

## Known blockers and deferred scope

- No CPB was attached during the latest work; all CPB runtime/bootloader results
  are reproducible build evidence, not hardware validation.
- CPB touch and storage require missing native APIs and are deferred.
- Firefox has no WebUSB implementation; UF2 is its supported device workflow.
- BLE application features, Arcade boards, RP2040/ESP32 Arcade work, and
  high-resolution Arcade displays are outside v1.
- Current npm audit reports inherited vulnerabilities; controlled dependency
  upgrades are future work.

## Commands and acceptance gates

Run from the workspace root through the Makefile where possible:

```sh
make status
make pxt-check
make static-build
make static-firefox-check
make production-browser-check
make production-firefox-check
make codal-build
make bootloader-build
```

`make static-build` creates the versioned OCI archive, metadata, checksums, and
Quadlet under ignored `artifacts/static/`. Deployment is intentionally a
reviewed service-account operation, not an unattended Make target.

## Resume checklist

```sh
cd /home/jim/git/makecode
make status
git status --short
git -C pxt status --short
git -C pxt-circuit-playground status --short
```

If the browser repair is not yet deployed, resume ordered item 1. Otherwise
resume CPB hardware/runtime acceptance. Never install firmware without a board
present and explicit confirmation of the intended device/recovery path.
