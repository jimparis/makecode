# Circuit Playground MakeCode

This project builds and hosts one modern, self-contained MakeCode editor for
both Adafruit Circuit Playground boards:

- [Circuit Playground Express](https://www.adafruit.com/product/3333) (CPX,
  SAMD21)
- [Circuit Playground Bluefruit](https://www.adafruit.com/product/4333) (CPB,
  nRF52840)

**Try the live editor: [makecode.jim.sh](https://makecode.jim.sh/)**

| Circuit Playground Express | Circuit Playground Bluefruit |
| --- | --- |
| ![A MakeCode Blocks project running in the Circuit Playground Express simulator](docs/images/editor-express.png) | ![The same MakeCode Blocks project running in the Circuit Playground Bluefruit simulator](docs/images/editor-bluefruit.png) |

## Why this exists

Adafruit's original [Circuit Playground MakeCode
editor](https://makecode.adafruit.com/) focuses on the Circuit Playground
Express. Microsoft's [MakeCode Maker editor](https://maker.makecode.com/) also
has Circuit Playground board definitions, including Bluefruit support.
However, both sites use relatively old MakeCode stacks, and the Maker editor's
Circuit Playground support in particular has substantial bugs.

We wanted one maintained site where projects can move between CPX and CPB
without losing source, where built-in compilation and simulation work without
Microsoft cloud services, and where both boards share a polished,
Circuit-Playground-specific interface.

The hosted editor includes self-hosted immutable share links. Normal editor
sessions make no telemetry or other implicit third-party requests; GitHub and
external packages are optional, user-initiated features.

## Repository layout

This orchestration repository pins four independently versioned source
repositories as Git submodules:

| Directory | Purpose |
| --- | --- |
| `pxt/` | Source-built fork of the MakeCode/PXT framework |
| `pxt-circuit-playground/` | Circuit Playground target, blocks, simulator, documentation, and web package |
| `codal-circuit-playground-bluefruit/` | Circuit Playground Bluefruit CODAL runtime |
| `Adafruit_nRF52_Bootloader/` | Bluefruit UF2/DFU bootloader and HF2 WebUSB support |

Each top-level commit records the exact commit of every source repository.
Each source repository also retains an `upstream` remote so fixes can be
compared with and contributed back to the original project. See
[STATUS.md](STATUS.md) for the implementation state, reproducible baselines,
test results, and remaining hardware acceptance work.

## Building and testing

The top-level Makefile runs the editor and native toolchains in pinned
containers. Initialize the four top-level submodules after cloning (the
bootloader build initializes only the nested submodules it needs):

```sh
git clone https://github.com/jimparis/makecode.git
cd makecode
make submodules-init
make status
```

A typical editor build is:

```sh
make pxt-install
make pxt-check
make pxt-serve
```

On Linux, direct WebUSB upload also requires permission to open the supported
boards' USB device nodes. The repository includes a narrow udev policy for the
CPX application and bootloader and the CPB application/bootloader identities.
After reviewing it, install it once as root; the invoking user must belong to
the `plugdev` group:

```sh
make udev-check
sudo make udev-install
```

Unplug and reconnect the board if its existing device node does not acquire
`plugdev` read/write access after installation. UF2 file download does not
require WebUSB or this policy.

Submodules are checked out at the parent repository's exact gitlinks. Before
editing one, switch it to its development branch. Commit and push the child
first, then stage and commit the new gitlink in this repository. For example:

```sh
git -C pxt switch circuit-playground-13.1.5
# edit, test, commit, and push pxt
git add pxt
git commit -m "Update pinned PXT framework"
```

The complete native and release gates are:

```sh
make codal-check
make codal-build
make bootloader-check
make bootloader-build
make static-build
make static-firefox-check
```

`static-build` produces a versioned, read-only container and runs the full
Chrome browser acceptance suite. The Firefox gate additionally tests offline
project export/import and validates downloaded CPX and CPB UF2 files. Release
artifacts are written beneath `artifacts/`, which is intentionally not tracked
by Git.

Deployment uses the static package baked into the container; it does not
mount a source checkout over the application. See
[deployment/README.md](deployment/README.md) for the service layout, share-data
backup procedure, and rollback process.

## Project status

The editor and self-hosted sharing service are deployed as an alpha. Automated
Chrome and Firefox acceptance is extensive, but physical-board validation is
still required for CPB WebUSB flashing, bootloader recovery, speaker cold
boots, and the full peripheral matrix. Do not treat generated CPB bootloader
artifacts as hardware-proven releases yet.

This project is independently maintained and is not an official Adafruit or
Microsoft service. Microsoft MakeCode/PXT and the Adafruit-derived components
retain their respective upstream licenses and trademarks.
