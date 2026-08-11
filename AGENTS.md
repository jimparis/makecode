# Workspace instructions

Before changing code, read [`STATUS.md`](STATUS.md) completely. It contains the
agreed plan, current implementation state, known build failures, and ordered
unfinished work. Update it whenever a milestone, blocker, or important design
decision changes.

This directory orchestrates three independent repositories for the unified
Circuit Playground MakeCode project:

- `pxt-circuit-playground/` — editor, board packages, simulator, docs, CI, and
  deployment assets.
- `codal-circuit-playground-bluefruit/` — CPB-specific nRF52840 native runtime.
- `Adafruit_nRF52_Bootloader/` — CPB bootloader with the HF2 WebUSB interface.

Work locally as `jim`. Run commands from `/home/jim/git/makecode` through the
top-level Makefile where possible. Each child has independent Git history and
must retain an `upstream` remote; do not turn the children into submodules.

Production deployment belongs to the `makecode` service account on
`psychosis`; use `ssh makecode@psychosis` for service-account operations.
Production serves a versioned static-package container and must not bind-mount
a source checkout over the application directory.

Keep CPX and CPB built-in firmware reproducible and usable without the cloud.
Cloud services are optional for sharing and external packages. Do not publish
or push changes unless the user asks for it.
