PXT_DIR := $(CURDIR)/pxt-circuit-playground
PXT_CORE_DIR := $(CURDIR)/pxt
NODE_IMAGE := docker.io/library/node@sha256:673fce836d5a9185da33352682bfedb17c174d016370d08616748dff76fda862
PXT_CONTAINER := podman run --rm -v $(CURDIR):/workspace:Z -w /workspace/pxt-circuit-playground $(NODE_IMAGE)
PXT_CORE_CONTAINER := podman run --rm -v $(CURDIR):/workspace:Z -w /workspace/pxt $(NODE_IMAGE)

.PHONY: status pxt-core-install pxt-core-build pxt-install pxt-check pxt-firmware-bounds pxt-static-check pxt-cpb-build static-build static-browser-check static-firefox-check production-browser-check production-firefox-check pxt-serve codal-check codal-build bootloader-check bootloader-build

status:
	@git -C pxt status --short --branch
	@git -C pxt-circuit-playground status --short --branch
	@git -C codal-circuit-playground-bluefruit status --short --branch
	@git -C Adafruit_nRF52_Bootloader status --short --branch

pxt-core-install:
	$(PXT_CORE_CONTAINER) npm ci --ignore-scripts
	$(PXT_CORE_CONTAINER) npm run prepare

pxt-core-build: pxt-core-install
	$(PXT_CORE_CONTAINER) env PXT_ENV=production npm run build

pxt-install: pxt-core-build
	$(PXT_CONTAINER) npm ci

pxt-check: pxt-cpb-build pxt-install
	$(PXT_CONTAINER) npm test
	$(MAKE) pxt-firmware-bounds

pxt-firmware-bounds:
	$(PXT_CONTAINER) node scripts/check-firmware-bounds.js built/hexcache

pxt-static-check:
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

codal-check:
	node scripts/check-codal-board.js
	node scripts/check-codal-memory.js

codal-build: codal-check
	node scripts/build-codal.js

bootloader-check: codal-check
	node scripts/check-bootloader.js

bootloader-build: bootloader-check
	node scripts/build-bootloader.js

pxt-serve:
	podman run --rm -it \
		-p 127.0.0.1:3232:3232 \
		-p 127.0.0.1:3233:3233 \
		-v $(CURDIR):/workspace:Z -w /workspace/pxt-circuit-playground $(NODE_IMAGE) \
		node node_modules/pxt-core/built/pxt.js serve --hostname 0.0.0.0
