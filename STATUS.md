# Circuit Playground MakeCode status

Last updated: 2026-08-12

This is the operational handoff for the project. Git history contains completed
work; this file tracks the current state, constraints, blockers, and remaining
work. External blockers are in [`BLOCKERS.md`](BLOCKERS.md).

## Goal

Publish one maintainable editor at <https://makecode.jim.sh> for:

- Adafruit Circuit Playground Express (CPX, SAMD21)
- Adafruit Circuit Playground Bluefruit (CPB, nRF52840)

Both boards must support editing, simulation, offline built-in compilation,
safe UF2 download, project persistence/export/import, and board switching that
preserves source. Chrome/Chromium should support direct WebUSB/WebHID transfer;
Firefox must support everything except direct transfer. Sharing is hosted on
the same origin and must not depend on Microsoft services.

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
- Pin the five independently versioned source repositories as submodules.
  Preserve each `upstream` remote and publish child commits before updating the
  parent gitlink.
- CPB application flash is `0x26000..<0xEA000`; the bootloader starts at
  `0xF4000`. Do not relax these bounds.

## Pinned source repositories

| Repository | Role | Pinned commit |
| --- | --- | --- |
| `pxt/` | PXT framework fork | `0401803bed9f` |
| `pxt-circuit-playground/` | target/editor/simulator | `4a46712eefe4` |
| `codal-circuit-playground-bluefruit/` | CPB native runtime | `30d62c331ea2` |
| `Adafruit_nRF52_Bootloader/` | CPB HF2 bootloader | `e7b48c5467de` |
| `uf2-samdx1/` | official CPX UF2/HF2 bootloader | `d4dc92889759` |

The parent gitlinks are the source of truth for this combination. All have
public `jimparis/*` origins; initialized children retain `upstream`. Use
`make submodules-init` after cloning and `make status` to verify exact pins and
cleanliness. Milestone commits should be pushed after a relevant gate and
secret scan.

## Current production

`makecode.jim.sh` currently serves release
`v0.15.77-alpha.9c2852b5fa67`. It provides:

- the unified CPX/CPB editor and polished dark Standard theme;
- two locally hosted, hand-drawn home banners that alternate on full page loads;
- exactly two validated built-in firmware caches;
- same-origin project publishing and clean share links;
- release-aware service workers and no implicit external requests;
- a curated, offline-opening extension gallery with pinned recommendations,
  consistent fallback artwork, installed-package visibility, and removal;
- WebUSB-based direct transfer with no WebHID pairing dependency;
- one modern connection-dialog flow shared by CPX and CPB; board selection
  supplies the hardware-specific name, runtime, simulator, and UF2;
- a deliberate `...` menu ordered as `Choose Hardware`, `Download as File`,
  and `Connect Device` / `Connect New Device`;
- guided `Connect Device` / `Send to Board` actions, retry/manual-download/
  cancel failure choices, board-specific manual-copy instructions, and
  expandable Linux troubleshooting inside the connection dialogs;
- a same-origin, checksummed official Adafruit CPX v4 bootloader updater that
  adds HF2 WebUSB and a hardware-derived persistent USB serial;
- a same-origin, checksummed CPB HF2 bootloader updater with version checks,
  warnings, installation verification, and recovery documentation;
- automatic repair of stale board dependencies and invalid native caches,
  verified against the affected Firefox profile on `basis`;
- a rootless container on `psychosis`, bound to `127.0.0.1:3232`, with Apache
  terminating TLS and a persistent share-data mount.

The site remains an alpha with `X-Robots-Tag: noindex, nofollow`.

## Remaining work, in order

### 1. CPB hardware/runtime acceptance

- The same-board HF2 updater now builds reproducibly, is validated for family,
  board ID, address bounds, vectors, UICR, completeness, and negative
  mutations, and is packaged on the production site. Hardware installation and
  recovery testing remain outstanding.
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

### 2. Cross-browser and physical-device acceptance

- The pinned official Adafruit v4.0.0 updater has been installed on the
  attached CPX. HF2 readback verified every updater page before execution; the
  resulting bootloader reports v4.0.0, the CPX board ID and SAMD21 family, a
  hardware-derived serial, and the HF2 WebUSB interface. Public instructions
  cover the normal UF2 copy plus the checked Linux HID fallback required by the
  tested legacy v1.22.0 SFHR bootloader.
- Confirm 25 CPX direct upload/run cycles with no unexpected UF2 fallback.
- Run 25 direct upload/run cycles per board in Linux Chrome/Chromium and
  Chromebook Chrome; verify retry, explicit UF2 fallback, and reconnect behavior.
- Chromebook CPX testing found unnecessary pairing/success clicks, a cramped
  troubleshooting control, and a successful-flash/failed-reconnect race. The
  local next release opens the browser chooser from the first click, sends the
  pending program immediately after authorization, removes the redundant
  reconnect and assembly button, and uses the bootloader's real USB product
  name. Chromebook retesting is pending.
- Manually confirm Firefox persistence, simulator, export/import, and UF2.
- Review theme hover/focus/disabled states and color-picker placement on the
  actual Chromebook and Linux desktop.
- Verify CPX hardware, including infrared, after the unified-site changes.

### 3. Product and operations cleanup

- Finish shared capability APIs and kid-friendly starter projects.
- Remove remaining unused Maker assets and resolve useful `missing in sim`
  diagnostics where practical.
- Add the production share directory to normal backups.
- Add optional GHCR publication with pinned builders and no PR secrets. GitHub
  Actions now runs read-only, pinned CPX/CPB builds while local reproducibility
  remains the source of truth.
- Triage inherited npm vulnerabilities deliberately; never use
  `npm audit fix --force` as a blanket upgrade.

### 4. Public v1

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
- The product-specific udev rule is installed on `psychosis`; the attached CPX
  now runs the verified Adafruit v4.0.0 bootloader at `239a:0018`, with a
  persistent hardware serial and HF2 WebUSB interface.
- Apache passes through the application-owned `Permissions-Policy` and
  `X-Robots-Tag` headers without adding duplicates.
- The headless Firefox gate currently reaches and passes the extension checks,
  then times out waiting for Monaco's hover tooltip for an already-present CPB
  unsupported-API diagnostic. Chromium production acceptance passes cleanly.

## Commands and acceptance gates

Run from the workspace root through the Makefile where possible:

```sh
make submodules-init
make submodules-check
make status
make pxt-check
make static-build
make static-firefox-check
make production-browser-check
make production-firefox-check
make codal-build
make bootloader-build
make cpx-bootloader-build
```

`make static-build` creates the versioned OCI archive, metadata, checksums, and
Quadlet under ignored `artifacts/static/`. Deployment is intentionally a
reviewed service-account operation, not an unattended Make target.

## Resume checklist

```sh
cd /home/jim/git/makecode
make submodules-init
make status
git status --short
```

Never install firmware without a board present and explicit confirmation of
the intended device/recovery path.
