# Circuit Playground MakeCode status

Last updated: 2026-08-11

This file is the handoff and source of truth for the project. Do not assume an
item is complete merely because a file or partial implementation exists. Keep
this document current as work proceeds.

External conditions that prevent acceptance or deployment are tracked in
[`BLOCKERS.md`](BLOCKERS.md).

## Goal and release criteria

Build and publicly host one maintainable MakeCode editor at
`https://makecode.jim.sh` for:

- Adafruit Circuit Playground Express (CPX, SAMD21)
- Adafruit Circuit Playground Bluefruit (CPB, nRF52840)

The target should feel like the old Adafruit Circuit Playground MakeCode
editor, while using the current PXT editor and supporting both boards in one
site. A project can change boards without silently deleting source; shared
hardware APIs behave the same where the boards permit it, and incompatible
board-specific features produce a clear diagnostic.

Public v1 is not complete until all of the following are true:

- CPX and CPB are the only boards presented by the editor.
- Built-in Blocks and TypeScript projects compile to safe UF2 images.
- Core editing, simulation, built-in compilation, UF2 download, and WebUSB do
  not require a live Microsoft service after the static release assets have
  been built.
- Direct WebUSB/HF2 upload is reliable on both boards in Chrome/Chromium.
- UF2 remains a recovery and Firefox-compatible fallback.
- The CPB speaker works on every tested cold boot, not intermittently.
- The simulator does not hang when tones start, stop, or repeat.
- Standard/high-contrast theme switching and color-picker placement work on
  the children's Chromebook displays and the Linux desktop.
- The hardware and browser acceptance matrix later in this file passes.

An internal alpha may be deployed earlier with reliable UF2 downloads. CPB
WebUSB remains a public-v1 gate, not an alpha gate.

## Locked product decisions

- Show only CPX and CPB, preserving familiar Circuit Playground blocks and UX.
- Use one target/site with a board chooser and project board switching.
- Do not promise import compatibility with projects created by
  `adafruit.makecode.com`; projects created by this site must still save and
  round-trip normally.
- WebUSB is the primary final workflow for both boards. One initial UF2 or SWD
  bootloader installation is acceptable.
- Host the first usable HTTPS deployment at `makecode.jim.sh`; HTTPS is needed
  for WebUSB on non-loopback clients.
- Chromebook Chrome and Linux Chrome/Chromium are WebUSB targets. Firefox must
  support the editor, simulator, persistence, and UF2 download, but Firefox
  does not implement WebUSB.
- Self-host project publishing, immutable share data, and share links at
  `makecode.jim.sh`; sharing must not depend on the Microsoft MakeCode cloud.
  GitHub and external package services remain optional and may be contacted
  only after an explicit user action.
- Do not initialize telemetry or make any implicit third-party request. Cloud
  access is reserved for a user's explicit sharing, package, or GitHub action.
- Actual Bluetooth APIs, BLE application support, MakeCode Arcade boards,
  RP2040/ESP32 Arcade work, and higher-resolution Arcade displays are outside
  v1.
- Develop as `jim` under `/home/jim/git/makecode`. Use the `makecode` account
  only for production service operations on psychosis.
- Keep the PXT framework, editor target, CODAL runtime, and bootloader as
  independent peer Git repositories for now. They remain normal checkouts, not
  submodules, pending an explicit decision on whether the orchestration root
  should own their exact revisions as gitlinks.
- Build `pxt-core` from the source-controlled `jimparis/pxt` fork based on the
  exact upstream `v13.1.5` tag. Do not patch generated or minified JavaScript.
  Keep `pxt-common-packages` as an exact-version npm build input.

## Repository layout and pinned baselines

The workspace root is an orchestration-only Git repository coordinating four
source repositories (five Git repositories total):

| Path | Role | Baseline | Current remote state |
| --- | --- | --- | --- |
| `.` | Orchestration/deployment | initial commit `006bc707d89c` | `origin` = `jimparis/makecode` |
| `pxt/` | MakeCode/PXT framework | upstream tag `v13.1.5`, commit `e717183abbb0` | `origin` = `jimparis/pxt`; preserved `upstream` |
| `pxt-circuit-playground/` | PXT target/editor | `microsoft/pxt-maker` commit `de46b65eaa71ce6f2eb0f29f5db7fb69d33cc63d` | `origin` + preserved `upstream` |
| `codal-circuit-playground-bluefruit/` | CPB native runtime | `mmoskal/codal-nrf52840-dk` commit `00d69e508749b33aadd91f43e68abd542467fb8f` | `origin` + preserved `upstream` |
| `Adafruit_nRF52_Bootloader/` | CPB bootloader | `adafruit/Adafruit_nRF52_Bootloader` commit `c67f0bcf0fa8e841426335b1bbde91cda6ca1f50` | `origin` + preserved `upstream` |

Useful upstream reference points:

- Port selected familiar APIs/assets from `microsoft/pxt-adafruit` commit
  `f045710530898f6f2f4f197bfaea7957daafcd14`; do not revive its obsolete PXT
  dependency stack.
- The original CPB runtime locked `codal-nrf52` at
  `c77a3adaf4c06f883457e47fe05e233d33999838`. The worktree now locks the later
  USB-capable `codal-nrf52` commit
  `04df6d3a15c972ce1c0bd8146737c0bb179db2b7` together with its same-minute
  `codal-core` counterpart
  `1076c9a4388809a4e2c262d62b0064108066ab19`.

Public GitHub destinations created and first pushed on 2026-08-11 are:

- `jimparis/makecode` for the orchestration root
- `jimparis/pxt`
- `jimparis/pxt-circuit-playground`
- `jimparis/codal-circuit-playground-bluefruit`
- `jimparis/Adafruit_nRF52_Bootloader`

The user authorized regular milestone commits and pushes on 2026-08-11. When
configured, each child should use `origin` for the Jim Paris fork and retain
`upstream`. Run a secret scan and the relevant repository gate before each
public push; prefer smaller milestone commits going forward.

## Intended architecture

### Editor and board packages

Base the editor on current `pxt-maker`, not the abandoned `pxt-adafruit`
target. Pin exact PXT/npm versions with a lockfile and use Node 22: the current
Blockly dependency declares Node 22 or newer, and the upstream lockfile was out
of sync with `package.json`.

The target ID is `circuitplayground`. Its board picker contains only:

- `adafruit-circuit-playground-express`
- `adafruit-circuit-playground-bluefruit`

A shared `circuit-playground` package supplies board-neutral public APIs such
as `light.showRing()` and `input.ambientColor()`. The common v1 capability
contract is intended to include buttons A/B, slide switch, ten NeoPixels, red
LED, speaker/music, accelerometer, temperature, light, microphone/loudness,
named pins, analog/digital I/O, and capacitive touch. CPX infrared remains
explicitly CPX-only. CPB Bluetooth is hidden in v1.

Board switching must preserve source and blocks. If a project uses a
board-specific API, switching boards should leave the call intact and report
the unsupported capability rather than silently changing the program.

### CPB memory layout and native runtime

The current Maker definition is unsafe: it permits use through `0xF6000`, but
the current Adafruit CPB bootloader begins at `0xF4000` and reserves ten 4-KiB
pages of application data beneath it. The bootloader-accepted application
ceiling is therefore `0xEA000`.

Use these boundaries consistently:

- SoftDevice/application start: `0x26000`
- Application/UF2 end, exclusive: `0xEA000` (`958464` decimal)
- CODAL linker FLASH length: `0xC4000`
- Bootloader start: `0xF4000`
- Bootloader code/config boundary: `0xFD800`

The PXT `flashEnd`, CODAL manifests, and CODAL linker now agree on `0xEA000`.
The root contract test checks those boundaries, cross-checks the application
USB bootloader bounds against the bootloader linker, and rejects a generated
test image that exceeds the application region.

Create a CPB-specific CODAL target instead of continuing to identify the
firmware as a generic nRF52840 DK. Integrate nRF52840 USB support, set the CPB
pin/configuration data, enable userspace HF2, and provide the handoff that
resets into the HF2 bootloader. Keep the SoftDevice layout for possible future
BLE work even though application BLE is out of scope.

The speaker failure must be diagnosed rather than assumed to be PWM. On a
bench, compare good and bad cold boots at the speaker signal and amplifier
enable pins. Determine whether the fault is amp initialization, PWM instance
selection/resource collision, buffer-start timing, or another interaction.
Fix it in the narrowest CPB runtime/mixer layer and regression-test it with
NeoPixels, microphone, analog I/O, and repeated music operations active.

Audit the known weak CPB paths: analog reads, light sensor, loud-sound events,
microphone, touch, temperature, accelerometer, pixels, buttons, and slide
switch. Do not advertise a capability in the package until it has a physical
board test.

### CPB bootloader and WebUSB

The stock Adafruit CPB bootloader provides UF2/DFU but not MakeCode's HF2
interface. Application-only HF2 is insufficient because the browser must hand
off to a bootloader that can safely overwrite the application.

Extend the Adafruit bootloader with a TinyUSB vendor interface using USB class
255, subclass 42, protocol 1. Implement the HF2 operations needed by current
PXT, including `BININFO`, `INFO`, bootloader entry/start flash, flash-page
write, checksum/read operations used for partial flashing, reset to app, and
diagnostic output.

Every UF2 mass-storage write must validate the UF2 family and stay inside
`0x26000..<0xEA000`. HF2's `WRITE_FLASH_PAGE` command does not carry a family
field, so the HF2 bootloader must advertise `0xADA52840` in `BININFO`, rely on
the PXT host/device-family match, and independently reject every read or write
outside that same address range. Preserve UF2 mass-storage and USB DFU
recovery. Preserve BLE OTA if the HF2 implementation fits the existing bootloader region;
otherwise BLE OTA is the feature to remove, not UF2/DFU recovery. Removing
bootloader BLE OTA does not preclude future application BLE.

Produce and checksum:

- A one-time, bench-tested bootloader update UF2 for normal installation.
- A complete SWD recovery image.
- Release notes identifying the firmware as an unofficial CPB-specific build.

Use the existing Adafruit CPB USB identities only on genuine CPB hardware.
Before a broad public release, seek upstream confirmation/acceptance from
Adafruit; if a separate identity becomes necessary, obtain a legitimate
open-source PID rather than inventing or borrowing one.

CPX keeps its supported HF2/WebUSB bootloader workflow and official UF2
recovery path.

### Static site and deployment

Development uses `pxt serve` only. Production uses a MakeCode static package
with built-in CPX and CPB firmware caches, served from a minimal versioned
container. Ordinary built-in projects must keep working when Microsoft/GitHub
services are unavailable.

The static Go server maps PXT's `/static/` card URLs to packaged
`/docs/static/` assets and clean documentation routes such as `/boards` to
their rendered `/docs/*.html` pages. Missing static assets return 404 rather
than the editor shell. Generated Application Insights bootstrap blocks and the
SDK are removed from the release; a normal editor session makes no request to
Microsoft telemetry endpoints.

The same server implements the anonymous PXT publishing subset at `/api/`.
Immutable share records live in a service-owned persistent directory outside
the versioned image; clean `/_shareId` links redirect into PXT's `#pub:` route.
The release container is built from a pinned Go builder and a `scratch`
runtime, so Node, npm, the Go toolchain, PXT sources, and third-party web
services are not production runtime dependencies.

Run the production container rootlessly as `makecode`, bound only to
`127.0.0.1:3232`. Apache terminates TLS at `makecode.jim.sh`, proxies to the
container, and sends `Permissions-Policy: usb=(self)`. Do not repeat the old
Quadlet mistake in `/home/makecode`: its `%h/data:/app` mount hides the source
baked into the image.

Before public v1, serve the alpha with `X-Robots-Tag: noindex`. Remove that at
release. Browser project storage remains local (IndexedDB); the only
server-side data is immutable anonymous share storage, with no account service.

On Linux, provide a narrow udev rule for the exact CPX/CPB application and
bootloader USB IDs. Chromebook Chrome needs no local helper application.

## Current implementation state

### Completed workspace work

- Created the orchestration repository at `/home/jim/git/makecode`.
- Created the four peer source repositories at the paths listed above.
- Renamed each child's source remote to `upstream` and pinned its agreed base
  commit on a local `main` branch.
- Added the root `AGENTS.md`, `README.md`, `.gitignore`, and Makefile.
- The Makefile exposes `status`, editor checks/serving, a local CPB PXT native
  build, CODAL checks/builds, and bootloader checks/builds. Editor work uses a
  digest-pinned Node 22 Podman container; native builds use digest-pinned
  historical GCC 6 toolchain images.
- The user created `/etc/apache2/sites-enabled/makecode.jim.sh.conf`. It has a
  valid Apache syntax, redirects HTTP to HTTPS, uses the existing Jim TLS
  macros, and reverse-proxies the HTTPS origin to `127.0.0.1:3232`. The public
  response now carries `Permissions-Policy: usb=(self)`, alpha
  `X-Robots-Tag: noindex, nofollow`, and no-cache behavior. TLS uses the valid
  `makecode.jim.sh` Let's Encrypt certificate. The static container does not
  require forwarded-scheme information. For v1, remove `noindex` and give
  immutable hashed assets long cache lifetimes while keeping the HTML
  shell/manifest revalidatable.

The current `ProxyPass` includes WebSocket upgrade support on port 3232. That
is harmless for the production static container. If `pxt serve` proves to use
its separate port 3233 from a remote browser, add a narrow WebSocket proxy path
rather than publicly exposing port 3233 directly.

### Work in progress in `pxt-circuit-playground/`

These changes are committed in the target repository and pushed to its public
GitHub fork. Preserve their independent history when updating from upstream.

- Changed the target identity/title to Circuit Playground MakeCode.
- Removed other board packages from `bundleddirs`; only CPX and CPB board
  packages remain exposed.
- Simplified the package/project galleries to Circuit Playground-relevant
  content.
- Removed the stale/broken old package migration map.
- Changed the CPB PXT `flashEnd` from `0xF6000` to `0xEA000`.
- Changed the CPB compile service from the generic nRF52840 DK to
  `codal-circuit-playground-bluefruit`/`CIRCUIT_PLAYGROUND_BLUEFRUIT`, pinned
  its local toolchain image by digest, and enabled the PXT userspace HF2 and
  WebUSB flags now that both application and bootloader implementations build.
- Added `libs/circuit-playground/` with shared `showRing()` and
  `ambientColor()` APIs and toolbox namespace colors.
- Added that shared package to both board packages.
- Deferred CPB touch and storage. The generic nRF52840 runtime lacks both the
  USB configuration required by storage and the `CapTouchButton` native API
  required by the current PXT touch package. Re-enable each capability only
  when the CPB-specific runtime implements it.
- Changed the default new project from Metro M0 to CPX.
- Made the simulator source compatible with the PXT package's old shim
  compiler, including its consolidated standard library, while retaining a
  clean TypeScript compile under the installed modern compiler.
- Regenerated `package-lock.json` with Node 22 because upstream's lockfile did
  not match its declared PXT/Blockly dependencies.
- Added a strict local PXT CI wrapper. It invokes the exact pinned local CLI,
  treats emitted TypeScript errors as failures, and rejects any source-file
  drift caused by regeneration. It removes the ignored generated target bundle
  before each run so edits to `pxtarget.json` cannot be masked by stale output.
- Added Intel HEX checksum and address-bound validation for cached CPX and CPB
  firmware. CPX must stay inside `0x2000..<0x40000`; CPB must stay inside
  `0x26000..<0xEA000`.
- Removed non-product compile variants. Only `samd21` and `nrf52840` remain,
  and generated shim changes are limited to bundled packages.
- Narrowed board navigation and documentation to CPX/CPB, added a focused CPX
  page, updated the CPB page, and converted selected Maker-era tutorials from
  D-pin/pixel APIs to Circuit Playground A-pin/button/light APIs.
- Added compiler-level board-switch contract tests. A representative shared
  program compiles unchanged for CPX and CPB; a CPX infrared program compiles
  on CPX, retains its source when moved to CPB, and produces the expected
  unsupported-API diagnostic there.
- Replaced the inherited Maker package identity, README, target links, and
  core product documentation with Circuit Playground-specific material. Old
  board pages and unsupported Maker projects/shows are no longer published.
- Restricted static-package precompilation to each board's base package. This
  avoids invalid CPX/CPB dependency cross-products while retaining both
  board-specific built-in firmware caches.
- Added a strict static-package gate. It builds into disposable container
  storage, treats emitted TypeScript diagnostics as failures, rejects source
  drift, verifies required editor/docs/board metadata, and validates every
  packaged CPX/CPB firmware cache against its safe flash range. It derives the
  current base-image key for each board from PXT's own build, removes five
  historical cache entries and native/test build directories from release
  output, rewrites/verifies the PWA manifest against local packaged icons, and
  canonicalizes PXT's alternating cssnano reset layouts so identical sources
  produce byte-identical standard and RTL stylesheets.
- Fixed simulator board shutdown to use the full audio stop path. Resetting,
  stopping, or replacing the simulator now cancels queued instruction audio
  and disposes sequencers instead of stopping only the simple tone source. A
  target-local reentrancy guard also prevents the inherited mixer sequencer's
  stop-all callback from recursively invoking itself during teardown.
- Added an explicit empty-override Standard color theme and named it alongside
  PXT's high-contrast theme. The standard theme is now the fresh/invalid-state
  fallback, while both choices are available in the picker and persist across
  reloads. Enabled the editor's Save Project command so offline project
  export/import is a supported product path rather than a hidden PXT feature.
- Forked `microsoft/pxt` at the exact `v13.1.5` tag and moved every local PXT
  change into readable TypeScript source. The target consumes this local fork
  through `file:../pxt`; the former generated/minified JavaScript patch is
  deleted. The fork awaits board-dependency editor reloads, makes Monaco
  namespace lookup tolerate early theme notifications, uses package display
  names in the hardware chooser, keeps static share/API traffic on the serving
  origin, and avoids invalid relative-CDN region discovery. A root lockfile
  plus locked sub-application installs make the complete production PXT source
  build reproducible.
- Fixed a PXT board-switch race which removed conflicting package ancestors in
  parallel. Each removal rewrote the top-level package configuration, so a
  transitive no-op removal could finish last and restore the old board package.
  Conflict removals now run serially. Browser acceptance requires the selected
  CPB and CPX simulator board IDs to start, guarding the package/variant mismatch
  that produced TS9200 missing-shim diagnostics and an endless spinner.
- Added local `make static-browser-check`/`make static-firefox-check` and
  public-origin `make production-browser-check`/`make
  production-firefox-check` gates. They run with external requests blocked;
  the local pair starts the packaged, read-only container while the production
  pair exercises `https://makecode.jim.sh` through Apache and TLS. They validate
  the PWA and responsive home; create, reload, and switch a project in both
  JavaScript and Blocks; prove a retained CPX infrared call becomes a visible
  CPB Monaco error/squiggle and clears when removed; exercise theme
  selection/reset and invalid-theme startup fallback; verify the color picker
  at 80-200% zoom equivalents; run a real looping user melody across ten
  simulator restarts and three Home/project-reopen cycles; and perform 50
  direct tone/stop cycles, 20 instruction-buffer cancellation cycles,
  sequencer disposal, and board teardown. Firefox additionally exercises real
  project export/import and validates downloaded CPB/CPX UF2 files.

### Native runtime and bootloader work in progress

These changes are committed in their independent child repositories and pushed
to their public GitHub forks.

- Renamed the CMake library and generated binary identity from generic
  `NRF52840_DK` to `CIRCUIT_PLAYGROUND_BLUEFRUIT` in both target manifests.
- Changed the linker FLASH region to `0x26000` with length `0xC4000`, ending at
  `0xEA000`, and exported/asserted the application start, end, and final flash
  image boundaries.
- Added matching `DEVICE_FLASH_START`/`DEVICE_FLASH_END` target configuration.
- Added a root contract test that validates the CMake/manifest/linker identity,
  pinned dependency commits, linked boundary symbols, and rejection of an
  oversized test image.
- Added a reproducible native build using CODAL shell commit
  `e6952acdf1d8e790c439c6ba06cff44c0263356c` and digest-pinned
  `docker.io/pext/yotta`. It writes local HEX/BIN/ELF files, build metadata, and
  SHA-256 checksums under ignored `artifacts/codal/`.
- Enabled the later nRF52840 USB implementation with the genuine CPB
  `0x239A:0x0045` application identity, 64-byte packets, eight regular endpoint
  slots, and the no-auto-ZLP endpoint flag. The target also supplies the real
  bootloader code bounds required by CODAL's optional GhostFAT handoff logic.
- Updated both dependency manifests to the verified paired 2021 CODAL core and
  nRF52 revisions. A clean pinned-container build compiles `NRF52USB.cpp`; no
  USB interface is instantiated by the current sample application yet.
- Extended the root CODAL contract test to reject USB constants, dependency
  revisions, or bootloader code boundaries that drift from this verified
  baseline.
- Replaced every inherited `BLENano` model/file/symbol with a
  `CircuitPlaygroundBluefruit` device model. The model covers all eight pads,
  light/temperature aliases, the internal LIS3DH bus/interrupt, PDM microphone,
  speaker/amplifier, buttons, slide switch, NeoPixels, and red LED, including
  nRF P1 GPIO support.
- Replaced the generic pin enum with the official CPB rev-D mapping, including
  external serial/I2C/SPI aliases and internal QSPI pins. Startup now applies
  the Adafruit button/slide pulls, disables the red LED, and enables the speaker
  amplifier. It no longer performs the inherited BLENano NFC-UICR rewrite.
- Added a three-repository board contract test. It cross-checks PXT and CODAL
  pad/peripheral/QSPI pins, checks the overlapping bootloader LED/button/pixel
  pins and USB identity, and rejects any remaining `BLENano` model identity.
- Verified that application-side WebUSB/HF2 is already supplied by the pinned
  `pxt-common-packages` core. Added a local nRF52 `platform.h` override that
  sets `USB_HANDOVER=0`: the Adafruit bootloader has no in-place handover table,
  so current PXT must reject `START_FLASH`, issue `RESET_INTO_BOOTLOADER`, and
  reconnect. The root contract now verifies that host fallback order and the
  shared application/bootloader reset markers.
- Added a CPB-only TinyUSB HF2 vendor interface to the bootloader with class
  255, subclass 42, protocol 1 and 64-byte bulk endpoints. It implements the
  current PXT `BININFO`, `INFO`, start/reset, 256-byte flash write, bounded word
  read, and diagnostic commands. Reads and writes are restricted to
  `0x26000..<0xEA000`; reset-to-app flushes the cached page, validates the
  Cortex-M vector table, and updates bootloader application state.
- Kept HF2 disabled for other bootloader boards. Both required regression
  targets (`feather_nrf52840_express` and `feather_nrf52832`) still compile.
- Added reproducible `make bootloader-check`/`make bootloader-build` targets.
  The build uses pinned top-level submodules, a workspace-local
  `intelhex==2.3.0`, a fixed `SOURCE_DATE_EPOCH`, validates compiled USB
  descriptors and updater address/family records, and produces checksummed
  updater-UF2, ELF/HEX, and full SoftDevice recovery HEX artifacts.
- Added `make pxt-cpb-build`. It creates a clean representative MakeCode
  project, copies the sibling CPB runtime into a disposable CODAL
  shell, forces PXT past its generic runtime cache, and compiles with the
  digest-pinned GCC 6 image. It verifies the generated CPB target/binary, linked
  userspace HF2/USB symbols and reset-only handoff override, Intel HEX bounds,
  every UF2 block's family/address range, and reproducible checksums under
  ignored `artifacts/pxt-cpb/`. It also installs the resulting native runtime
  HEX at PXT's content-addressed cache key, allowing target CI and static
  packaging to use the unpublished local runtime without a cloud compile.
- Added `make static-build` and deployment assets. The static builder
  normalizes PXT's generated manifest timestamp, canonicalizes the two
  alternating upstream CSS minifier layouts, and rejects manifest drift for
  identical source/builder inputs independently of the derived release name.
  It builds from digest-pinned Node and Go builder images with a fixed
  timestamp, uses a `scratch` runtime as an unprivileged numeric user with a
  read-only root filesystem, and live-tests the loopback editor plus
  WebUSB/noindex headers and publishing API. It creates an explicitly
  versioned image and OCI archive, OCI/site checksums, build metadata, and a
  validated rendered Quadlet under ignored `artifacts/static/`; temporary
  image-context/OCI directories are removed and no production operation is
  performed.
- Corrected the static home/board-picker presentation. The header now uses one
  responsive Circuit Playground text mark on a high-contrast teal menu, the
  home page has a subtle branded background and real CPX/CPB/project artwork,
  and the unrelated inherited breadboard hero is gone. Board-picker cards use
  the short names `Bluefruit` and `Express`, contain no Beta badges, and their
  help button resolves to the packaged Boards documentation.
- Reworked the Standard editor appearance into a coherent dark theme with a
  dark teal header, dark Monaco/workspace surfaces, colored toolbox categories,
  visible selected/hover labels and icons, and explicit contrast-safe category
  colors. Automated Chrome and Firefox sweep every toolbox category, including
  the formerly invisible selected Math state. Ported the original Adafruit
  ten-pixel ring field editor to current Blockly, enabled PXT's song editor,
  and supplied the missing 16-color runtime palette required by song previews.
- Replaced the nginx-only static runtime with a small same-origin Go service.
  `POST /api/scripts` and immutable metadata/text/thumbnail reads implement the
  PXT anonymous publishing contract with strict target/editor validation,
  request/text/thumbnail limits, unguessable 12-character IDs, per-client rate
  limiting, a 2 GiB storage quota, atomic durable 0600 records, and immutable
  read caching. A persistent rootless Quadlet mount keeps share records across
  versioned image upgrades. Unit and clean-recipient browser tests publish,
  fetch, follow the clean share redirect, and reopen source without Microsoft.

## Known build results and failures

1. `npm ci` under `node:22-bookworm` completes from the regenerated lockfile.
   The dependency audit reports 38 inherited vulnerabilities (4 low, 8
   moderate, 23 high, and 3 critical); do not
   run `npm audit fix --force`, because that would make uncontrolled breaking
   upgrades. Triage them after the target builds reproducibly.
2. `make pxt-check` passes with Node 22. It first rebuilds and validates the
   local CPB native runtime cache, then the pinned local PXT CLI builds the
   target/simulator without asking the public compile service for CPB, validates
   docs and links, and round-trips all 136 selected snippets through Blocks and
   Python with zero failures.
3. CPX builds against its current upstream runtime. The current locally built
   CPB cache uses the custom runtime and covers `0x26000..<0x403CC` (107,468
   data bytes); the current cached CPX baseline covers `0x2000..<0x25100`
   (143,616 data bytes). The release derives and retains exactly these two
   current base images; both pass the checksum and safe-address gate.
4. The previous CPB `CodalUSB.cpp` configuration failure is resolved in the
   custom runtime. A generated PXT application now compiles against that local
   runtime and links `CodalUSB`, userspace HF2, and the reset-only bootloader
   handoff. The bootloader HF2 implementation also builds. Both sides remain
   hardware-untested. The separate touch attempt still lacks the target-level
   `CapTouchButton` API; storage and touch therefore remain deliberately absent
   from the CPB editor package.
5. The board-switch contract passes for shared APIs and for the CPX infrared
   rejection case on CPB. Packaged-editor Chrome and Firefox automation proves
   CPB-to-CPX JavaScript switching and CPX-to-CPB Blocks switching preserve the
   program while selecting the correct variant and capability toolbox. It also
   retains a CPX-only infrared call on CPB, observes the visible Monaco
   unsupported-property diagnostic and error squiggle, and proves the
   diagnostic clears after the invalid call is removed.
6. `make pxt-static-check` passes. The generated static site contains the
   editor shell, simulator, target metadata, focused product/legal docs, both
   board packages, and exactly two checksum/address-validated firmware caches:
   CPX `e1c671...f650` and the local CPB runtime `e0b25a...af52`. Five
   historical caches and build-only output are excluded.
7. Target generation still reports many upstream `missing in sim` diagnostics
   and four optional theme assets requested by PXT CSS but absent from both
   this target and its pinned Maker upstream. It emits no TypeScript errors and
   does not mutate source-controlled files. These diagnostics are cleanup work
   rather than hidden build failures.
8. `make codal-check` passes and proves that a four-byte-overflow test image is
   rejected. `make codal-build` passes with the locked GCC 6 toolchain and the
   USB-capable dependency pair. Its current sample HEX covers
   `0x26000..<0x2C2E8` (25,320 data bytes); this is a
   build/identity/memory/USB-driver baseline, not yet hardware-ready CPB
   firmware. Current SHA-256 prefixes are `609a86c4...` (HEX), `21b9aea3...`
   (BIN), and `5e76bbcc...` (ELF), with full values in
   `artifacts/codal/SHA256SUMS`.
9. The old CODAL dependencies do not link with the host GCC 14 toolchain and
   their default `RelWithDebInfo` build also produces invalid DWARF assembly.
   This is why the reproducible target deliberately pins the declared GCC 6
   container rather than treating the host-toolchain failure as target code.
10. `make bootloader-build` passes twice with identical SHA-256 output. The CPB
    HF2 bootloader uses 34,268 bytes of the 38 KiB code region (88.07%); its
    load image ends at `0xFC8A4`, leaving 3,932 bytes before `0xFD800`. BLE OTA,
    CDC, UF2 MSC, and USB DFU remain compiled in. The nRF52840 and nRF52832
    Feather regression builds pass. Current SHA-256 prefixes are `2d064ec8...`
    (ELF), `4122af2e...` (HEX), `ce58f0cf...` (updater UF2), and `c9da6bd0...`
    (full S140 recovery HEX), with full values in
    `artifacts/bootloader/SHA256SUMS`. None has been installed on hardware yet.
11. `make pxt-cpb-build` passes twice from clean disposable build trees with
    identical SHA-256 output. The representative application includes buttons,
    pixels, sound, temperature, serial logging, userspace HF2, and USB. Its
    runtime HEX covers `0x26000..<0x403CC`; its 483-block final UF2 ends at
    `0x44300`, carries family `0xADA52840` on every block, and stays below
    `0xEA000`. Current SHA-256 prefixes are `d67b43e9...` (UF2), `33dad325...`
    (runtime HEX), and `93d1ec32...` (ELF), with full values in
    `artifacts/pxt-cpb/SHA256SUMS`. It has not run on hardware yet.
12. The cleaned/versioned static release builder passes after normalizing
    PXT's timestamped manifest line and canonicalizing the two upstream CSS
    minifier layouts. It also removes 381 generated Application Insights
    bootstrap blocks and the SDK, validates decoded home/board images and
    header contrast, proves `/boards` is documentation, and requires missing
    `/static` assets to return 404. The current package contains 1,272 files
    with site digest
    `748f803027285759b9e0134d1eebed0abfe8405ccad4e284d9534ba721104a09`
    as release `v0.15.77-alpha.ada3a59ebcfa` and image ID
    `695f0f05ccb8c7e9ca3907c397c5c7ae1972077a0d43eccc781550c672ebfbe1`.
    The 22,077,440-byte version-named OCI archive has SHA-256
    `cf7ea0fc0ded0597b0d5130565053773ef32307968ed7e6725837746216670cc`.
    Its metadata records clean target commit `622a1cfc16ea` and clean PXT
    framework commit `fcb723a568c3`, plus both source-tree digests.
    Live ephemeral containers pass editor-shell, loopback, read-only,
    `Permissions-Policy`, alpha `X-Robots-Tag`, Chrome 151, and Firefox 140 ESR
    checks with exactly zero external requests. The checks cover PWA/offline
    behavior, responsive/visual home layout, board-picker names/badges/help,
    reload persistence, bidirectional JavaScript/Blocks board switching with a
    stable, topmost visible simulator whose board ID and board-specific image
    both match the selected hardware, a visible unsupported-API diagnostic,
    theme reset/fallback including invalid
    saved state at startup, every toolbox category's selected-state contrast,
    same-origin publish/read and clean-recipient share reopening, 80-200%
    color-picker placement, a real user melody
    through ten simulator restarts and three project reopens, 50 direct tone
    cycles, 20 instruction-buffer cancellations, sequencer disposal, and board
    teardown. Firefox additionally round-trips an exported project PNG through
    the Import UI and validates downloaded CPB and CPX UF2s block-by-block for
    structure, family ID, and flash bounds. The Quadlet and OCI version label
    agree and validate locally.
13. The Monaco theme-regeneration race is guarded in the PXT source fork:
    namespace lookup treats the brief pre-initialization window as an empty
    map. Automated startup with a removed saved theme now resets to Standard
    without a page exception; high-contrast/Standard selection and persistence
    continue to pass in Chrome and Firefox.
14. Rich audio acceptance exposed an inherited mixer defect: registering a
    sequencer installs a stop-all listener which calls `muteAllChannels()` from
    inside `muteAllChannels()` and overflows the stack. The target simulator
    now guards that exported entry point against reentry. Chrome 151 and
    Firefox 140 ESR both pass the instruction-audio and sequencer teardown
    regression plus the real melody restart/project-reopen stress. No
    `pxt-common-packages` file is patched; all framework changes are maintained
    as source commits in the versioned PXT fork.
15. Release `v0.15.77-alpha.ada3a59ebcfa` is deployed on `psychosis` as the
    rootless `makecode` service. The remote OCI checksum, image ID, version
    label, read-only root, dropped capabilities, service user, `/tmp` tmpfs,
    loopback-only `127.0.0.1:3232` binding, and sole writable persistent share
    mount were verified. The Quadlet generator
    links the service into the user `default.target`; account linger is enabled,
    the service survives restart, and its journal has no warnings. The broken
    legacy `arcade.container` was recoverably moved to
    `/home/makecode/retired/arcade.container.pre-circuit-playground-20260811`
    so it cannot race for the same port after reboot. Public HTTPS serves files
    byte-identical to the release and passes the full Chrome 151 and Firefox
    140 ESR gates with zero external requests. Both browsers publish and reopen
    same-origin shares; production records are mode 0600, immutable reads and
    clean-link redirects work, and the journal is clean. Public `/static`
    artwork has the correct image MIME type, `/boards` serves rendered
    documentation, missing static files return 404, and the editor shell
    contains no Application Insights bootstrap or Visual Studio/Azure
    telemetry endpoint.
16. The public root README now leads with the live editor, links the official
    Adafruit CPX and CPB product pages, explains the limitations of the old
    Adafruit and Maker editors, and shows an example Blocks project on both
    simulators. CPX is shown first; its black PCB and the newer CPB's blue PCB
    are captured from stable board-specific simulator frames rather than a
    transient fallback frame. Personal session/path instructions were removed.

## Ordered unfinished work

### 1. Clean UF2-capable editor baseline (complete)

- CPB storage and touch are deferred until the custom runtime supplies their
  native prerequisites.
- The Node 22 install/check path, fatal TypeScript diagnostic check, and
  generated-file drift gate are encoded.
- Both board packages build and all cached firmware passes checksum/address
  validation.
- Only bundled-package shim changes remain, and only the SAMD21/nRF52840
  compile variants remain in target metadata.

### 2. Finish editor, API, simulator, and documentation behavior

- Complete the shared capability APIs, including named touch aliases where
  the native runtime supports them.
- Board switching with retained source and explicit unsupported-feature
  diagnostics is covered at compiler/package and browser UI levels in both
  JavaScript and Blocks, including visible Monaco error feedback.
- Make the standard theme the reliable default, retain high contrast as an
  option, and add a reset/migration path for stuck appearance state. Fresh,
  high-contrast, standard-reset, reload, and invalid-theme fallback paths now
  pass in Chrome and Firefox, and the early Monaco/toolbox race is guarded by
  the PXT source fork. Retain physical Chromebook acceptance.
- The visual theme audit now covers home, editor, every toolbox category's
  idle/selected state, flyouts, dialogs, menus, Monaco, simulator controls, and
  Standard/high contrast in Chrome and Firefox. The former selected-Math
  white-on-white failure is fixed with a full dark Standard palette, inverted
  colored toolbox, and contrast gate. Retain physical Chromebook/desktop
  review for hover/focus/disabled states and subjective polish. The live
  Adafruit site remains a visual reference only: it uses an obsolete PXT stack,
  while this target source-builds its telemetry-free PXT 13.1.5 fork.
- Reproduce and fix color-picker positioning at Chromebook resolutions and
  80–200% zoom. Automated Chrome and Firefox checks now pass at 1024x600 and
  80%, 125%, and 200% CSS-viewport equivalents; retain physical Chromebook
  acceptance.
- Reproduce simulator audio hangs. Board teardown now invokes PXT's full audio
  stop/cancellation path, and 50 direct tone/stop cycles, 20 rendered
  instruction-buffer cancellations, sequencer disposal, and teardown pass in
  Chrome and Firefox. A real looping melody also passes ten simulator restarts
  and three Home/project-reopen cycles in each browser.
- Remove remaining unused Maker assets and finish kid-friendly starter
  projects. Focused CPX/CPB board, board-switch, UF2/recovery, product, privacy,
  and terms pages are now present.
- Add strict CI that fails on emitted TypeScript errors, generated-file drift,
  broken internal docs, either board failing to compile, unsafe UF2 addresses,
  or static-package failure. This gate is now encoded; keep extending its
  coverage as runtime and deployment work begins.

### 3. Build the CPB-specific CODAL runtime

- Rename/configure the target and binary for Circuit Playground Bluefruit.
  The build/library/binary identity and the device model/pin map are now
  CPB-specific and guarded by a cross-repository contract test.
- Change the linker FLASH region to `0x26000` with length `0xC4000`. This is
  complete, including positive and negative linker-contract tests.
- Integrate the later nRF52840 USB driver and all required CODAL USB config.
  This compile-time baseline is complete, including locked compatible core
  and nRF52 revisions, CPB VID/PID, endpoint settings, and bootloader bounds.
- Userspace HF2 comes from the pinned PXT common core. The reset handoff and
  CPB application USB identity/endpoint contract are encoded. A real PXT
  application now compiles reproducibly against the local runtime and the
  editor flags are enabled; validate enumeration and handoff on hardware.
- Keep CPB storage disabled until its native path is implemented and tested.
- Diagnose/fix sound and audit the remaining board capabilities on hardware.
- Add native builds and memory-boundary checks to CI.
  A pinned local build and boundary gate now exist; wire them into future
  hosted CI after repository creation is authorized.

### 4. Build the HF2-capable CPB bootloader

- The CPB-only HF2 vendor interface and bounded command handler compile while
  preserving UF2/CDC/DFU and BLE OTA.
- Reproducibly produced the updater UF2 and full S140 SWD recovery image;
  installation and hardware testing remain.
- Test application-to-bootloader handoff, repeated partial/full flashes,
  disconnect/reconnect, invalid UF2 rejection, and recovery from a bad app.
- The exact code headroom is 3,932 bytes and BLE OTA still fits. Recheck this
  gate on every bootloader change.

### 5. Complete reproducible packaging and deployment

- Root Makefile targets cover release artifacts plus local and public Chrome/
  Firefox acceptance. The service-account deployment flow remains documented
  rather than wrapped in an unattended mutation target.
- PXT is built in production mode from the pinned local source fork before the
  target is installed. Release identity and metadata include both the target
  and framework commits, dirty states, and source-tree digests.
- Build local CPX/CPB firmware caches into the static package. The current
  CPX base cache and reproducible custom CPB base cache are included and
  validated; five obsolete cache entries are automatically pruned from the
  release.
- The static-package container uses digest-pinned Node and Go build
  environments and a `scratch` runtime. It is content-addressed, reproducible,
  unprivileged, read-only, and loopback-tested. Static CSS is canonicalized so
  PXT's alternating but equivalent minifier output cannot change release
  identity, and the previous-manifest gate now compares unchanged sources even
  when a divergent output would derive a different version string.
- The failed old `/home/makecode` Arcade Quadlet was retired recoverably only
  after the new image passed loopback and public checks; its bind-mounted data
  was not deleted.
- A corrected rootless Quadlet template, generator validation, live HTTP check,
  deterministic OCI handoff archive, and rollback instructions now exist. The
  current version is installed under `/home/makecode/releases/`, loaded by
  rootless Podman, and started by the generated user service.
- The existing Apache HTTPS vhost now exposes the WebUSB permissions policy,
  alpha noindex header, and no-cache policy. Remove noindex and implement the
  final immutable-asset cache policy only for public v1.
- The self-hosted publishing service is deployed behind
  `https://makecode.jim.sh/api/` with persistent service-owned storage. Its PXT
  anonymous publish/read/thumbnail contract, clean share links, limits,
  unguessable immutable IDs, rate limiting, content checks, bounded storage,
  durable records, and clean-recipient reopening pass publicly in Chrome and
  Firefox. Add the share directory to the normal host backup schedule using
  the documented release procedure.
- Generate/install the narrow Linux udev rule and validate Chrome access.
- GitHub origins are configured and the authorized milestone commits are
  pushed publicly; every child retains `upstream`. Add narrowly scoped Actions
  and GHCR workflows next, with digest-pinned builders and no repository
  secrets required for pull-request validation.

### 6. Acceptance testing and public release

Automated and manual acceptance must cover:

- The same representative Blocks and TypeScript programs on both boards.
- A CPX infrared program producing a clear unsupported diagnostic on CPB.
- Fifty CPB cold boots running an immediate tone, with sound on every boot.
- Repeated melodies, silence/restart, and concurrent pixels/sensors without a
  hardware or simulator hang.
- Twenty-five consecutive WebUSB compile/upload/run cycles per board without
  repairing or re-pairing.
- UF2 recovery on both boards and SWD recovery of CPB.
- All advertised sensors, inputs, outputs, touch pads, pins, serial, and board
  switching on physical hardware.
- Chromebook Chrome and Linux Chrome: editor, simulator, pairing, WebUSB,
  reconnect, and UF2 fallback.
- Linux Firefox: editor, simulator, persistence, project export/import, and UF2
  download. All now pass automatically, including CPB and CPX UF2s; retain
  manual user workflow confirmation.
- Theme selection/reset and correctly anchored menus/color pickers across the
  Chrome/Firefox automated viewport matrix passes; physical Chromebook and
  Linux desktop confirmation remain.
- A fresh browser with Microsoft/GitHub endpoints blocked: built-in projects
  compile, simulate, and download with zero external requests in Chrome and
  Firefox. Direct upload remains part of the hardware-blocked WebUSB matrix.

Remove the alpha `noindex` header and call the release v1 only after this
matrix passes.

## Immediate resume checklist

Start here in the next implementation session:

```sh
cd /home/jim/git/makecode
make status
git -C pxt-circuit-playground diff
```

The clean UF2 editor baseline, compiler/browser board-switch contracts,
exact two-image static cache, versioned static-package gate, CPB CODAL runtime,
local PXT application/HF2 build, and CPB HF2 bootloader build are green.
Continue ordered tasks 3 and 4 with CPB hardware enumeration,
application-to-bootloader handoff, flashing, sound, and capability tests.
Task 5's same-origin publishing release `v0.15.77-alpha.ada3a59ebcfa` is
deployed at `https://makecode.jim.sh`; public Chrome/Firefox gates pass with
zero external requests. No
CPB was attached during the latest session, so no firmware was installed.
Browser automation now covers Blocks,
visible CPB diagnostics for a retained CPX-only API, invalid-theme startup
reset, 80-200% color-picker placement, ten real-melody simulator restarts,
three project reopens, 50-cycle direct audio teardown, 20 instruction-audio
cancellations, sequencer disposal, Firefox persistence and project
export/import, and validated CPB and CPX UF2 downloads.
The current reproducible local handoff and production release is
`v0.15.77-alpha.ada3a59ebcfa`. Retain manual download confirmation, physical
Chromebook/Linux checks, WebUSB, and all hardware acceptance. Local milestone
commits now exist in the PXT framework (`fcb723a568c3`), PXT target
(`622a1cfc16ea`), CODAL (`30d62c331ea2`), and bootloader (`7836c7cc3d81`)
repositories and are pushed to their public GitHub origins. Only versioned
static releases, not
a source checkout or firmware, are installed on `psychosis`.
