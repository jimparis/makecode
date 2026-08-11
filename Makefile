PXT_DIR := $(CURDIR)/pxt-circuit-playground
PXT_CORE_DIR := $(CURDIR)/pxt
SUBMODULES := pxt pxt-circuit-playground codal-circuit-playground-bluefruit Adafruit_nRF52_Bootloader
NODE_IMAGE := docker.io/library/node@sha256:673fce836d5a9185da33352682bfedb17c174d016370d08616748dff76fda862
PXT_CONTAINER := podman run --rm -v $(CURDIR):/workspace:Z -w /workspace/pxt-circuit-playground $(NODE_IMAGE)
PXT_CORE_CONTAINER := podman run --rm -v $(CURDIR):/workspace:Z -w /workspace/pxt $(NODE_IMAGE)

.PHONY: submodules-init submodules-check status pxt-core-install pxt-core-build pxt-install pxt-check pxt-firmware-bounds pxt-static-check pxt-cpb-build static-build static-browser-check static-firefox-check production-browser-check production-firefox-check pxt-serve codal-check codal-build bootloader-check bootloader-build

submodules-init:
	git submodule update --init -- $(SUBMODULES)
	@set -eu; \
	configure_upstream() { \
		repo=$$1; url=$$2; \
		if git -C "$$repo" remote get-url upstream >/dev/null 2>&1; then \
			git -C "$$repo" remote set-url upstream "$$url"; \
		else \
			git -C "$$repo" remote add upstream "$$url"; \
		fi; \
	}; \
	configure_upstream pxt https://github.com/microsoft/pxt.git; \
	configure_upstream pxt-circuit-playground https://github.com/microsoft/pxt-maker.git; \
	configure_upstream codal-circuit-playground-bluefruit https://github.com/mmoskal/codal-nrf52840-dk.git; \
	configure_upstream Adafruit_nRF52_Bootloader https://github.com/adafruit/Adafruit_nRF52_Bootloader.git

submodules-check:
	@set -eu; \
	for repo in $(SUBMODULES); do \
		expected=$$(git ls-files --stage "$$repo" | awk '$$1 == "160000" { print $$2 }'); \
		if test -z "$$expected"; then echo "$$repo is not pinned as a submodule" >&2; exit 1; fi; \
		if ! actual=$$(git -C "$$repo" rev-parse HEAD 2>/dev/null); then echo "$$repo is not initialized; run make submodules-init" >&2; exit 1; fi; \
		if test "$$actual" != "$$expected"; then echo "$$repo is at $$actual, expected $$expected" >&2; exit 1; fi; \
		if test -n "$$(git -C "$$repo" status --porcelain)"; then echo "$$repo has uncommitted changes" >&2; exit 1; fi; \
		if ! git -C "$$repo" remote get-url upstream >/dev/null 2>&1; then echo "$$repo has no upstream remote; run make submodules-init" >&2; exit 1; fi; \
	done; \
	test "$$(git -C pxt remote get-url upstream)" = https://github.com/microsoft/pxt.git || { echo "pxt has the wrong upstream remote; run make submodules-init" >&2; exit 1; }; \
	test "$$(git -C pxt-circuit-playground remote get-url upstream)" = https://github.com/microsoft/pxt-maker.git || { echo "pxt-circuit-playground has the wrong upstream remote; run make submodules-init" >&2; exit 1; }; \
	test "$$(git -C codal-circuit-playground-bluefruit remote get-url upstream)" = https://github.com/mmoskal/codal-nrf52840-dk.git || { echo "codal-circuit-playground-bluefruit has the wrong upstream remote; run make submodules-init" >&2; exit 1; }; \
	test "$$(git -C Adafruit_nRF52_Bootloader remote get-url upstream)" = https://github.com/adafruit/Adafruit_nRF52_Bootloader.git || { echo "Adafruit_nRF52_Bootloader has the wrong upstream remote; run make submodules-init" >&2; exit 1; }

status: submodules-check
	@git status --short --branch
	@git submodule status -- $(SUBMODULES)
	@git -C pxt status --short --branch
	@git -C pxt-circuit-playground status --short --branch
	@git -C codal-circuit-playground-bluefruit status --short --branch
	@git -C Adafruit_nRF52_Bootloader status --short --branch

pxt-core-install: submodules-check
	$(PXT_CORE_CONTAINER) npm ci --ignore-scripts
	$(PXT_CORE_CONTAINER) npm run prepare

pxt-core-build: pxt-core-install
	$(PXT_CORE_CONTAINER) env PXT_ENV=production npm run build

pxt-install: pxt-core-build
	$(PXT_CONTAINER) npm ci

pxt-check: pxt-cpb-build pxt-install
	$(PXT_CONTAINER) npm test
	$(MAKE) pxt-firmware-bounds

pxt-firmware-bounds: submodules-check
	$(PXT_CONTAINER) node scripts/check-firmware-bounds.js built/hexcache

pxt-static-check: submodules-check
	$(PXT_CONTAINER) npm run test:static

pxt-cpb-build: codal-check
	node scripts/build-pxt-cpb.js

static-build: pxt-check
	node scripts/build-static.js
	node scripts/check-static-browser.js

static-browser-check:
	node scripts/check-static-browser.js

static-firefox-check:
	BROWSER=firefox node scripts/check-static-browser.js

production-browser-check:
	STATIC_ORIGIN=https://makecode.jim.sh node scripts/check-static-browser.js

production-firefox-check:
	STATIC_ORIGIN=https://makecode.jim.sh BROWSER=firefox node scripts/check-static-browser.js

codal-check: submodules-check
	node scripts/check-codal-board.js
	node scripts/check-codal-memory.js

codal-build: codal-check
	node scripts/build-codal.js

bootloader-check: codal-check
	node scripts/check-bootloader.js

bootloader-build: bootloader-check
	node scripts/build-bootloader.js

pxt-serve: submodules-check
	podman run --rm -it \
		-p 127.0.0.1:3232:3232 \
		-p 127.0.0.1:3233:3233 \
		-v $(CURDIR):/workspace:Z -w /workspace/pxt-circuit-playground $(NODE_IMAGE) \
		node node_modules/pxt-core/built/pxt.js serve --hostname 0.0.0.0
