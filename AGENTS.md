# Workspace instructions

Before changing code, read [`STATUS.md`](STATUS.md) completely. It contains the
agreed plan, current implementation state, known build failures, and ordered
unfinished work. Update it whenever a milestone, blocker, or important design
decision changes.

This directory orchestrates five independently versioned repositories, pinned
at exact commits as Git submodules, for the unified Circuit Playground MakeCode
project:

- `pxt/` — source-built MakeCode/PXT framework fork.
- `pxt-circuit-playground/` — editor, board packages, simulator, docs, CI, and
  deployment assets.
- `codal-circuit-playground-bluefruit/` — CPB-specific nRF52840 native runtime.
- `Adafruit_nRF52_Bootloader/` — CPB bootloader with the HF2 WebUSB interface.
- `uf2-samdx1/` — official Adafruit CPX UF2/WebUSB bootloader source.

Work locally as `jim`. Run commands from `/home/jim/git/makecode` through the
top-level Makefile where possible. Run `make submodules-init` after a fresh
clone and `make submodules-check` before building. Each child has independent
Git history and must retain an `upstream` remote. Commit and push child changes
before committing the updated top-level gitlink; never pin the parent to an
unpublished child commit. Do not use `git submodule update --remote` as an
unreviewed upgrade mechanism.

Production deployment belongs to the `makecode` service account on
`psychosis`; use `ssh makecode@psychosis` for service-account operations.
Production serves a versioned static-package container and must not bind-mount
a source checkout over the application directory.

Keep CPX and CPB built-in firmware reproducible and usable without the cloud.
Cloud services are optional for sharing and external packages. After an
implemented change passes its relevant checks, commit and push each affected
child repository, commit and push the updated parent gitlinks, then deploy the
versioned static-package release to production unless the user explicitly asks
to keep the work local or to skip deployment. Never deploy a failed or
partially validated build.
