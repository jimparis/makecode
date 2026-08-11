# Circuit Playground MakeCode workspace

This workspace builds a single MakeCode editor for the Adafruit Circuit
Playground Express and Circuit Playground Bluefruit. It keeps the editor,
nRF52840 runtime, and Bluefruit bootloader as independent upstream-trackable
repositories while providing one place for development and release commands.

See [`STATUS.md`](STATUS.md) for the full implementation plan, current state,
known failures, and next tasks.

## Layout

| Directory | Purpose |
| --- | --- |
| `pxt-circuit-playground/` | MakeCode target, blocks, simulator, documentation, and web deployment |
| `codal-circuit-playground-bluefruit/` | Circuit Playground Bluefruit CODAL runtime |
| `Adafruit_nRF52_Bootloader/` | Bluefruit UF2/DFU bootloader and HF2 WebUSB support |

The root repository tracks orchestration and documentation only. The three
child directories are deliberately normal Git repositories rather than
submodules so each fork can be developed, synchronized, and contributed
upstream independently.

## Development

The reproducible editor toolchain runs in a Node container:

```sh
make pxt-install
make pxt-check
make pxt-cpb-build
make pxt-serve
```

The Bluefruit runtime contract and pinned native build are available from the
same top-level Makefile:

```sh
make codal-check
make codal-build
make bootloader-check
make bootloader-build
make static-build
```

`codal-check` cross-checks the CPB pin/USB identities across the editor,
runtime, and bootloader, and validates the native memory/linker bounds.
`pxt-cpb-build` compiles a representative MakeCode program against a clean
copy of the checked-out CPB runtime, verifies the linked userspace HF2 symbols,
UF2 family and application bounds, and writes checksummed output under
`artifacts/pxt-cpb/`.
`codal-build` uses the locked CODAL dependency commits and a digest-pinned
toolchain container. It writes checksummed local output under
`artifacts/codal/`; that directory is ignored by Git and is not a published
release.

`bootloader-build` initializes only the four pinned top-level bootloader
submodules, uses a workspace-local Python environment for `intelhex`, builds
the CPB image plus the required nRF52840/nRF52832 Feather regressions, and
writes a checksummed CPB updater UF2 and complete SoftDevice recovery HEX under
`artifacts/bootloader/`. These images are development artifacts until they pass
the hardware acceptance matrix in `STATUS.md`.

`static-build` validates the complete editor first, normalizes PXT's generated
manifest timestamp, verifies repeatable site and image digests, builds a
rootless read-only scratch image with a pinned Go builder, and performs live
loopback static-site and publishing-API smoke tests. The site, OCI image
archive, rendered Quadlet, and
checksums are written under `artifacts/static/`; see
[`deployment/README.md`](deployment/README.md) for the service-account handoff.

The development server listens on ports 3232 and 3233. Production is generated
as a static package and served behind Apache TLS at `makecode.jim.sh`.

For a future Codex session, start in this directory:

```sh
cd ~/git/makecode
codex
```

To resume an older chat whose saved directory differs, choose the current
directory when prompted or pass `-C ~/git/makecode` explicitly.
