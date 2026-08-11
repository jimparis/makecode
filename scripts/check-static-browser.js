#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const puppeteer = require(path.join(
    __dirname, "..", "pxt-circuit-playground", "node_modules", "puppeteer"
));

const workspace = path.resolve(__dirname, "..");
const metadataPath = path.join(workspace, "artifacts", "static", "BUILD-METADATA.json");

function fail(message) {
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

function capture(command, args) {
    const result = spawnSync(command, args, { cwd: workspace, encoding: "utf8" });
    if (result.error) fail(`${command} could not run: ${result.error.message}`);
    if (result.status !== 0) {
        fail(`${command} exited with status ${result.status}:\n${result.stdout || ""}${result.stderr || ""}`);
    }
    return result.stdout.trim();
}

function browserPath(browserName) {
    const override = browserName === "firefox" ? process.env.FIREFOX : process.env.CHROMIUM;
    if (override) return override;
    const candidates = browserName === "firefox"
        ? ["/usr/bin/firefox"]
        : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
    return candidates
        .find(filename => fs.existsSync(filename));
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForDownload(directory, extension, timeout = 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const files = fs.readdirSync(directory)
            .filter(filename => filename.endsWith(extension) &&
                !/\.(?:crdownload|part)$/i.test(filename));
        if (files.length === 1) {
            const filename = path.join(directory, files[0]);
            const firstSize = fs.statSync(filename).size;
            await delay(500);
            if (firstSize > 0 && fs.statSync(filename).size === firstSize) return filename;
        }
        await delay(250);
    }
    fail(`browser did not download a ${extension} file`);
}

function validateUf2(filename, label, family, startAddress, endAddress) {
    const data = fs.readFileSync(filename);
    assert(data.length >= 512 && data.length % 512 === 0,
        `downloaded UF2 has invalid size: ${data.length}`);
    let applicationBlocks = 0;
    for (let offset = 0; offset < data.length; offset += 512) {
        assert(data.readUInt32LE(offset) === 0x0a324655 &&
            data.readUInt32LE(offset + 4) === 0x9e5d5157 &&
            data.readUInt32LE(offset + 508) === 0x0ab16f30,
        `downloaded UF2 block ${offset / 512} has invalid magic`);
        const flags = data.readUInt32LE(offset + 8);
        if (!(flags & 0x00002000)) continue;
        const address = data.readUInt32LE(offset + 12);
        const payloadSize = data.readUInt32LE(offset + 16);
        const actualFamily = data.readUInt32LE(offset + 28);
        assert(actualFamily === family,
            `downloaded ${label} UF2 block ${offset / 512} has family ` +
            `0x${actualFamily.toString(16)} instead of 0x${family.toString(16)}`);
        assert(address >= startAddress && address + payloadSize <= endAddress,
            `downloaded ${label} UF2 block ${offset / 512} is outside application flash`);
        applicationBlocks++;
    }
    assert(applicationBlocks > 0, `downloaded UF2 contains no ${label} application blocks`);
}

function validateProjectPng(filename) {
    const data = fs.readFileSync(filename);
    assert(data.length > 1024, `exported project PNG is unexpectedly small: ${data.length}`);
    assert(data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
        "exported project does not have a PNG signature");
}

async function clickVisible(page, selector) {
    await page.evaluate(value => {
        const element = [...document.querySelectorAll(value)].find(candidate => {
            const bounds = candidate.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
        });
        if (!element) throw new Error(`No visible element matches ${value}`);
        element.click();
    }, selector);
}

async function replaceMonacoSource(page, source) {
    await page.evaluate(() => {
        const input = [...document.querySelectorAll(".monaco-editor textarea.inputarea")]
            .find(element => {
                const bounds = element.closest(".monaco-editor").getBoundingClientRect();
                return bounds.width > 0 && bounds.height > 0;
            });
        if (!input) throw new Error("Monaco input is unavailable");
        input.focus();
    });
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    const inserted = await page.evaluate(value => document.execCommand("insertText", false, value), source);
    if (!inserted) fail("Monaco did not accept replacement source");
}

async function appendMonacoSource(page, source) {
    await page.evaluate(() => {
        const input = [...document.querySelectorAll(".monaco-editor textarea.inputarea")]
            .find(element => {
                const bounds = element.closest(".monaco-editor").getBoundingClientRect();
                return bounds.width > 0 && bounds.height > 0;
            });
        if (!input) throw new Error("Monaco input is unavailable");
        input.focus();
    });
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    const inserted = await page.evaluate(value => document.execCommand("insertText", false, value), source);
    if (!inserted) fail("Monaco did not accept appended source");
}

async function waitForSimulatorFrame(page, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const frame = page.frames().find(candidate => /simulator\.html/.test(candidate.url()));
        if (frame) return frame;
        await delay(100);
    }
    fail("packaged editor has no simulator iframe");
}

async function waitForSimulatorBoard(page, expectedBoardId, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let lastState;
    while (Date.now() < deadline) {
        const frame = page.frames().find(candidate => /simulator\.html/.test(candidate.url()));
        if (frame) {
            try {
                lastState = await frame.evaluate(() => ({
                    boardId: window.pxsim?.runtime?.board?.boardDefinition?.id,
                    hasRuntime: !!window.pxsim?.runtime,
                    hasBoard: !!window.pxsim?.runtime?.board
                }));
                if (lastState.boardId === expectedBoardId) return frame;
            } catch (error) {
                lastState = { detached: error.message };
            }
        }
        await delay(100);
    }
    fail(`simulator did not start the selected board ${expectedBoardId}: ${JSON.stringify({
        lastState,
        pageErrors: page.__pageErrors,
        consoleErrors: page.__consoleErrors
    })}`);
}

async function captureReadmeScreenshot(page, filename, source) {
    if (process.env.CAPTURE_README_SCREENSHOTS !== "1") return;
    const directory = path.join(workspace, "docs", "images");
    fs.mkdirSync(directory, { recursive: true });
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.evaluate(value => {
        const model = monaco.editor.getModels().find(candidate => /main\.ts$/.test(candidate.uri.path));
        model.setValue(value);
    }, "light.setAll(0xff0000)\ninput.buttonA.onEvent(ButtonEvent.Click, function () {\n" +
        "    light.setAll(0x007fff)\n})\n");
    await delay(500);
    await clickVisible(page, ".blocks-menuitem");
    await page.waitForFunction(() => /set\s+all\s+pixels\s+to/.test(document.body.innerText),
        { timeout: 30000 });
    await delay(1000);
    await page.screenshot({ path: path.join(directory, filename), type: "png" });
    await clickVisible(page, ".javascript-menuitem");
    await page.waitForFunction(() => window.monaco && monaco.editor.getModels()
        .some(model => /main\.ts$/.test(model.uri.path)), { timeout: 30000 });
    await page.evaluate(value => {
        const model = monaco.editor.getModels().find(candidate => /main\.ts$/.test(candidate.uri.path));
        model.setValue(value);
    }, source);
    await delay(500);
}

async function instrumentSimulatorAudio(frame) {
    await frame.waitForFunction(() => window.pxsim && pxsim.runtime &&
        pxsim.runtime.board && pxsim.AudioContextManager, { timeout: 30000 });
    await frame.evaluate(() => {
        const manager = pxsim.AudioContextManager;
        if (!window.__browserAcceptancePlayInstructions) {
            window.__browserAcceptancePlayInstructions = manager.playInstructionsAsync;
            manager.playInstructionsAsync = function (...args) {
                window.__browserAcceptanceAudioInstructions++;
                return window.__browserAcceptancePlayInstructions.apply(this, args);
            };
        }
        if (!window.__browserAcceptanceQueueInstructions) {
            window.__browserAcceptanceQueueInstructions = manager.queuePlayInstructions;
            manager.queuePlayInstructions = function (...args) {
                window.__browserAcceptanceAudioInstructions++;
                return window.__browserAcceptanceQueueInstructions.apply(this, args);
            };
        }
        window.__browserAcceptanceAudioInstructions = 0;
    });
}

async function restartSimulatorWithAudio(page, frame) {
    await frame.evaluate(() => {
        window.__browserAcceptancePreviousRuntime = pxsim.runtime;
        window.__browserAcceptancePreviousInstructionCount =
            window.__browserAcceptanceAudioInstructions;
    });
    await clickVisible(page, ".restart-button");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const currentFrame = page.frames().find(candidate => /simulator\.html/.test(candidate.url()));
        if (currentFrame && currentFrame !== frame) {
            await instrumentSimulatorAudio(currentFrame);
            await currentFrame.waitForFunction(() => window.__browserAcceptanceAudioInstructions > 0,
                { timeout: 30000 });
            return currentFrame;
        }
        if (currentFrame) {
            const restarted = await currentFrame.evaluate(() => pxsim.runtime && pxsim.runtime.board &&
                pxsim.runtime !== window.__browserAcceptancePreviousRuntime &&
                window.__browserAcceptanceAudioInstructions >
                    window.__browserAcceptancePreviousInstructionCount);
            if (restarted) return currentFrame;
        }
        await delay(100);
    }
    const editorState = await page.evaluate(() => ({
        restartButtons: [...document.querySelectorAll(".restart-button")].map(element => ({
            disabled: element.disabled,
            visible: element.getBoundingClientRect().width > 0,
            title: element.getAttribute("title")
        })),
        markers: monaco.editor.getModelMarkers({}).map(problem => problem.message),
        sources: monaco.editor.getModels()
            .filter(model => /main\.ts$/.test(model.uri.path))
            .map(model => model.getValue())
    }));
    let simulatorState;
    try {
        simulatorState = await frame.evaluate(() => ({
            audioInstructions: window.__browserAcceptanceAudioInstructions,
            runtimeChanged: pxsim.runtime !== window.__browserAcceptancePreviousRuntime,
            hasBoard: !!(pxsim.runtime && pxsim.runtime.board)
        }));
    } catch (error) {
        simulatorState = { detached: error.message };
    }
    fail(`simulator did not restart the user melody: ${JSON.stringify({ editorState, simulatorState })}`);
}

async function openProjectByName(page, name) {
    await page.evaluate(projectName => {
        const visible = element => {
            const bounds = element.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
        };
        const action = [...document.querySelectorAll('[role="button"], button, a, .card, [tabindex="0"]')]
            .filter(element => visible(element) && element.innerText.includes(projectName))
            .sort((left, right) => left.innerText.length - right.innerText.length)[0];
        if (!action) {
            throw new Error(`Project card is missing: ${projectName}`);
        }
        action.click();
    }, name);
}

async function publishAndReopenProject(page, browser, browserName, origin, sourceMarker, expectedVariant) {
    await clickVisible(page, '[aria-label="Share Project"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"], .modal')]
        .some(element => element.getBoundingClientRect().width > 0 &&
            /^Share Project\b/.test(element.innerText)), { timeout: 30000 });
    await page.evaluate(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"], .modal')]
            .find(element => element.getBoundingClientRect().width > 0 &&
                /^Share Project\b/.test(element.innerText));
        const publish = dialog && [...dialog.querySelectorAll('button, [role="button"]')]
            .find(element => (element.innerText || element.title || "").trim() === "Share Project");
        if (!publish) throw new Error("Share Project publish action is missing");
        publish.click();
    });
    let shareUrl;
    try {
        shareUrl = await page.waitForFunction(expectedOrigin => {
            const dialog = [...document.querySelectorAll('[role="dialog"], .modal')]
                .find(element => element.getBoundingClientRect().width > 0 &&
                    /^Share Project\b/.test(element.innerText));
            const input = dialog && [...dialog.querySelectorAll("input")]
                .find(element => /^https?:/.test(element.value));
            if (!input) return false;
            const parsed = new URL(input.value);
            return parsed.origin === expectedOrigin && new RegExp("^/_[23456789A-HJ-NP-Za-km-z]{12}$").test(parsed.pathname)
                ? parsed.href : false;
        }, { timeout: 30000 }, origin).then(handle => handle.jsonValue());
    } catch (error) {
        const dialog = await page.evaluate(() => [...document.querySelectorAll(
            '[role="dialog"], .modal'
        )].filter(element => element.getBoundingClientRect().width > 0)
            .map(element => element.innerText));
        fail(`publishing did not return a same-origin URL: ${JSON.stringify({
            dialog,
            requests: page.__apiRequests,
            responses: page.__apiResponses,
            externalRequests: [...page.__externalRequests],
            pageErrors: page.__pageErrors,
            consoleErrors: page.__consoleErrors
        })}`);
    }
    const share = await page.evaluate(async url => {
        const id = new URL(url).pathname.slice(1);
        const [metadataResponse, textResponse] = await Promise.all([
            fetch(`/api/${id}`), fetch(`/api/${id}/text`)
        ]);
        return {
            id,
            metadataStatus: metadataResponse.status,
            textStatus: textResponse.status,
            metadata: await metadataResponse.json(),
            text: await textResponse.json()
        };
    }, shareUrl);
    assert(share.metadataStatus === 200 && share.textStatus === 200,
        `published project is unreadable: ${JSON.stringify(share)}`);
    assert(share.metadata.target === "circuitplayground" &&
        Object.values(share.text).some(value => typeof value === "string" && value.includes(sourceMarker)),
    `published project did not retain its source: ${JSON.stringify(share)}`);

    const recipientContext = await browser.createBrowserContext();
    const recipient = await recipientContext.newPage();
    const recipientRequests = [];
    const recipientResponses = [];
    const recipientExternalRequests = new Set();
    const recipientPageErrors = [];
    const recipientConsoleErrors = [];
    if (browserName !== "firefox") await recipient.setRequestInterception(true);
    recipient.on("request", request => {
        const url = request.url();
        if (url.startsWith(`${origin}/api/`)) {
            recipientRequests.push({ url, method: request.method() });
        }
        const isLocal = url === origin || url.startsWith(`${origin}/`) ||
            /^(?:data|blob|devtools):/.test(url);
        if (!isLocal) recipientExternalRequests.add(url);
        if (browserName !== "firefox") {
            if (isLocal) request.continue();
            else request.abort();
        }
    });
    recipient.on("response", async response => {
        if (!response.url().startsWith(`${origin}/api/`)) return;
        recipientResponses.push({ url: response.url(), status: response.status() });
    });
    recipient.on("pageerror", error => recipientPageErrors.push(error.stack || error.message));
    recipient.on("console", message => {
        if (message.type() === "error") recipientConsoleErrors.push(message.text());
    });
    try {
        await recipient.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
        await recipient.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
        await recipient.waitForFunction(variant => window.pxt &&
            pxt.appTargetVariant === variant && location.hash === "#editor",
        { timeout: 60000 }, expectedVariant);
        await clickVisible(recipient, ".javascript-menuitem");
        await recipient.waitForFunction(marker => window.monaco && monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(marker)),
        { timeout: 30000 }, sourceMarker);
        assert(recipientExternalRequests.size === 0,
            `shared project requested third-party resources: ${[...recipientExternalRequests].join(", ")}`);
    } catch (error) {
        const state = await recipient.evaluate(() => ({
            href: location.href,
            hash: location.hash,
            variant: window.pxt && pxt.appTargetVariant,
            bodyText: document.body.innerText.slice(0, 4000)
        }));
        fail(`published project did not reopen: ${JSON.stringify({
            state,
            requests: recipientRequests,
            responses: recipientResponses,
            externalRequests: [...recipientExternalRequests],
            pageErrors: recipientPageErrors,
            consoleErrors: recipientConsoleErrors
        })}`);
    } finally {
        await recipientContext.close();
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.body.classList.contains("ReactModal__Body--open"),
        { timeout: 30000 });
    return share;
}

async function auditToolboxContrast(page, label) {
    const categoryNames = await page.evaluate(() => [...document.querySelectorAll(
        ".blocklyTreeRow"
    )].filter(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
    }).map(element => (element.querySelector(".blocklyTreeLabel")?.textContent || "").trim())
        .filter(name => name && !/^(?:Advanced|Extensions)$/i.test(name)));
    assert(categoryNames.some(name => /^Math$/i.test(name)),
        `${label}: Math category is missing from the toolbox: ${JSON.stringify(categoryNames)}`);

    for (const categoryName of categoryNames) {
        const result = await page.evaluate(name => {
            const visible = element => {
                const bounds = element.getBoundingClientRect();
                return bounds.width > 0 && bounds.height > 0;
            };
            const row = [...document.querySelectorAll(".blocklyTreeRow")]
                .find(element => visible(element) &&
                    (element.querySelector(".blocklyTreeLabel")?.textContent || "").trim() === name);
            if (!row) return { error: "row disappeared" };
            row.click();
            const text = row.querySelector(".blocklyTreeLabel");
            const icon = row.querySelector(".blocklyTreeIcon");
            const rgb = value => {
                const match = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[, /]+([\d.]+))?\)/.exec(value);
                return match && {
                    r: Number(match[1]), g: Number(match[2]), b: Number(match[3]),
                    a: match[4] === undefined ? 1 : Number(match[4])
                };
            };
            const luminance = color => {
                const channel = value => {
                    value /= 255;
                    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                };
                return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) +
                    0.0722 * channel(color.b);
            };
            const contrast = (left, right) => {
                const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
                return (values[0] + 0.05) / (values[1] + 0.05);
            };
            const background = rgb(getComputedStyle(row).backgroundColor);
            const foreground = text && rgb(getComputedStyle(text).color);
            const iconColor = icon && rgb(getComputedStyle(icon).color);
            return {
                selected: row.classList.contains("blocklyTreeSelected"),
                background,
                foreground,
                iconColor,
                textContrast: background && foreground && contrast(background, foreground),
                iconContrast: background && iconColor && contrast(background, iconColor)
            };
        }, categoryName);
        assert(!result.error && result.selected,
            `${label}: ${categoryName} did not enter a visible selected state: ${JSON.stringify(result)}`);
        assert(result.background && result.background.a === 1 && result.textContrast >= 4.5,
            `${label}: ${categoryName} label contrast is below 4.5:1: ${JSON.stringify(result)}`);
        if (result.iconColor) {
            assert(result.iconContrast >= 3,
                `${label}: ${categoryName} icon contrast is below 3:1: ${JSON.stringify(result)}`);
        }
    }
}

async function checkHomeLayout(page, width, height, label) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await delay(300);
    const layout = await page.evaluate(() => {
        const card = name => document.querySelector(`[aria-label="${name}"]`);
        const express = card("Circuit Playground Express");
        const bluefruit = card("Circuit Playground Bluefruit");
        const bounds = element => {
            const value = element.getBoundingClientRect();
            return { left: value.left, right: value.right, top: value.top, width: value.width };
        };
        return {
            viewportWidth: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            express: express && bounds(express),
            bluefruit: bluefruit && bounds(bluefruit)
        };
    });
    assert(layout.express && layout.bluefruit, `${label}: board cards are missing`);
    assert(layout.documentWidth <= layout.viewportWidth + 2,
        `${label}: page overflows horizontally (${layout.documentWidth} > ${layout.viewportWidth})`);
    for (const [board, bounds] of [["CPX", layout.express], ["CPB", layout.bluefruit]]) {
        assert(bounds.width >= 120, `${label}: ${board} card is unexpectedly narrow`);
        assert(bounds.left >= -1 && bounds.right <= layout.viewportWidth + 1,
            `${label}: ${board} card is outside the viewport`);
    }
    assert(layout.express.left !== layout.bluefruit.left || layout.express.top !== layout.bluefruit.top,
        `${label}: board cards overlap`);
}

async function checkHomeVisuals(page) {
    const visuals = await page.evaluate(async () => {
        const loadCardImage = async label => {
            const card = document.querySelector(`[aria-label="${label}"]`);
            const image = card && card.querySelector(".cardimage");
            const url = image && image.getAttribute("data-src");
            if (!url) return { label, error: "missing image URL" };
            const response = await fetch(url, { cache: "reload" });
            const blob = await response.blob();
            const decoded = await new Promise(resolve => {
                const element = new Image();
                element.onload = () => resolve({
                    width: element.naturalWidth,
                    height: element.naturalHeight
                });
                element.onerror = () => resolve({ width: 0, height: 0 });
                element.src = URL.createObjectURL(blob);
            });
            return {
                label,
                url,
                status: response.status,
                contentType: response.headers.get("content-type"),
                ...decoded
            };
        };
        const menu = document.querySelector("#mainmenu");
        const settings = document.querySelector("#settings-menuitem");
        const logo = [...document.querySelectorAll("#mainmenu .left.menu .logo")]
            .find(element => {
                const bounds = element.getBoundingClientRect();
                return bounds.width > 0 && bounds.height > 0;
            });
        return {
            images: await Promise.all([
                loadCardImage("Circuit Playground Express"),
                loadCardImage("Circuit Playground Bluefruit")
            ]),
            menuInverted: menu.classList.contains("inverted"),
            menuBackground: getComputedStyle(menu).backgroundColor,
            settingsColor: getComputedStyle(settings).color,
            settingsWidth: settings.getBoundingClientRect().width,
            logoText: logo && [...logo.querySelectorAll(".name, .name-short")]
                .filter(element => {
                    const bounds = element.getBoundingClientRect();
                    return bounds.width > 0 && bounds.height > 0;
                }).map(element => element.textContent.trim()),
            visibleLogos: [...document.querySelectorAll("#mainmenu .left.menu .logo")]
                .filter(element => {
                    const bounds = element.getBoundingClientRect();
                    return bounds.width > 0 && bounds.height > 0;
                }).length,
            hasHero: !!document.querySelector(".getting-started-segment.hero"),
            homeBackground: getComputedStyle(document.querySelector(".ui.home.projectsdialog"))
                .backgroundImage
        };
    });
    for (const image of visuals.images) {
        assert(image.status === 200 && /^image\//.test(image.contentType || "") &&
            image.width > 0 && image.height > 0,
        `home card artwork is not a decodable image: ${JSON.stringify(image)}`);
    }
    assert(visuals.menuInverted && visuals.menuBackground === "rgb(7, 56, 77)" &&
        visuals.menuBackground !== visuals.settingsColor &&
        visuals.settingsWidth > 0,
    `home settings button is not visible against the header: ${JSON.stringify(visuals)}`);
    assert(visuals.logoText && visuals.logoText.length === 1 &&
        ["Circuit Playground MakeCode", "Circuit Playground"].includes(visuals.logoText[0]) &&
        visuals.visibleLogos === 1,
        `home header branding is missing or duplicated: ${JSON.stringify(visuals)}`);
    assert(!visuals.hasHero, "home screen still contains the unrelated breadboard hero image");
    assert(visuals.homeBackground && visuals.homeBackground !== "none",
        "home screen has no visual background treatment");
}

async function checkColorPicker(page, width, height, label) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await delay(300);
    const picker = await page.evaluate(() => {
        const field = [...document.querySelectorAll("g.blocklyDraggable")]
            .find(element => element.getBoundingClientRect().width > 0 && /ff0000/i.test(element.outerHTML));
        if (!field) throw new Error("converted workspace has no red color shadow block");
        const target = field.querySelector(".blocklyEditableField") || field;
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        const element = document.querySelector(".blocklyDropDownDiv");
        const bounds = element.getBoundingClientRect();
        return {
            visible: getComputedStyle(element).display !== "none" && bounds.width > 0 && bounds.height > 0,
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            width: bounds.width,
            height: bounds.height,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight
        };
    });
    assert(picker.visible, `${label}: Blockly color picker did not open`);
    assert(picker.left >= -1 && picker.top >= -1 &&
        picker.right <= picker.viewportWidth + 1 && picker.bottom <= picker.viewportHeight + 1,
    `${label}: Blockly color picker is outside the viewport: ${JSON.stringify(picker)}`);
    await page.keyboard.press("Escape");
}

async function selectTheme(page, themeName, expectHighContrast) {
    await clickVisible(page, "#settings-menuitem");
    await page.waitForFunction(() => [...document.querySelectorAll('[title="Theme"]')]
        .some(element => element.getBoundingClientRect().width > 0));
    await clickVisible(page, '[title="Theme"]');
    await page.waitForSelector("#theme-picker-modal", { visible: true, timeout: 30000 });
    const themes = await page.evaluate(() => [...document.querySelectorAll(
        "#theme-picker-modal .theme-card"
    )].map(element => element.innerText.trim()).sort());
    assert(themes.join(",") === "High Contrast,Standard",
        `theme picker has unexpected choices: ${themes.join(", ")}`);
    const beforeSelection = await page.evaluate(() => ({
        highContrast: document.body.classList.contains("hc"),
        bodyClass: document.body.className
    }));
    assert(beforeSelection.highContrast !== expectHighContrast,
        `theme was already selected before card activation: ${JSON.stringify(beforeSelection)}`);
    const themeTitle = themeName === "High Contrast"
        ? "#pxt-high-contrast-title"
        : "#circuit-playground-standard-title";
    const themeId = themeName === "High Contrast"
        ? "pxt-high-contrast"
        : "circuit-playground-standard";
    await page.evaluate(selector => {
        const title = document.querySelector(selector);
        const action = title && title.closest(".theme-card")
            .querySelector(".common-card-action");
        if (!action) throw new Error(`Theme action is missing: ${selector}`);
        action.setAttribute("data-browser-acceptance-theme", "true");
    }, themeTitle);
    await page.click('[data-browser-acceptance-theme="true"]');
    await page.waitForFunction(expected =>
        document.body.classList.contains("hc") === expected &&
        document.body.classList.contains("high-contrast") === expected,
    { timeout: 30000 }, expectHighContrast);
    try {
        await page.waitForFunction(expected => {
            const preferences = pxt.U.jsonTryParse(
                pxt.storage.getLocal("user-pref:colorThemeIds")
            ) || {};
            return preferences[pxt.appTarget.id] === expected;
        }, { timeout: 10000 }, themeId);
    } catch (error) {
        const state = await page.evaluate(() => ({
            target: pxt.appTarget.id,
            hasIdentity: pxt.auth.hasIdentity(),
            colorThemes: pxt.storage.getLocal("user-pref:colorThemeIds"),
            highContrast: pxt.storage.getLocal("user-pref:high-contrast"),
            userPreferences: typeof pxt.auth.userPreferences === "function"
                ? pxt.auth.userPreferences()
                : undefined,
            bodyClass: document.body.className
        }));
        fail(`theme preference was not saved: ${JSON.stringify(state)}`);
    }
    await clickVisible(page, '#theme-picker-modal [title="Close"]');
    await page.waitForSelector("#theme-picker-modal", { hidden: true, timeout: 30000 });
}

async function waitForEditorTheme(page, expectHighContrast) {
    await page.waitForFunction(expected => window.pxt && location.hash === "#editor" &&
        document.body.classList.contains("hc") === expected &&
        [...document.querySelectorAll("#settings-menuitem")]
            .some(element => element.getBoundingClientRect().width > 0),
    { timeout: 30000 }, expectHighContrast);
}

async function main() {
    if (!fs.existsSync(metadataPath)) fail("run make static-build before browser acceptance");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const browserName = process.env.BROWSER === "firefox" ? "firefox" : "chrome";
    const executablePath = browserPath(browserName);
    if (!executablePath) {
        fail(`${browserName} is not available; set ${browserName === "firefox" ? "FIREFOX" : "CHROMIUM"} to its executable path`);
    }

    let containerId = "";
    let browser;
    let origin;
    const configuredOrigin = process.env.STATIC_ORIGIN;
    if (configuredOrigin) {
        const parsedOrigin = new URL(configuredOrigin);
        if (!/^https?:$/.test(parsedOrigin.protocol) ||
            parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
            fail("STATIC_ORIGIN must be an HTTP(S) origin without a path, query, or fragment");
        }
        origin = parsedOrigin.origin;
    }
    const downloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "circuit-playground-browser-"));
    const shareDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "circuit-playground-shares-"));
    try {
        if (!origin) {
            containerId = capture("podman", [
                "run", "--rm", "-d", "--read-only", "--tmpfs", "/tmp:size=16m",
                "--userns", "keep-id", "--user", `${process.getuid()}:${process.getgid()}`,
                "-v", `${shareDirectory}:/var/lib/makecode-shares:Z`,
                "-p", "127.0.0.1::3232", metadata.imageTag
            ]);
            const binding = capture("podman", ["port", containerId, "3232/tcp"]);
            const portMatch = /:(\d+)\s*$/.exec(binding);
            if (!portMatch) fail(`could not parse published browser-test port: ${binding}`);
            origin = `http://127.0.0.1:${portMatch[1]}`;
        }
        const originHostname = new URL(origin).hostname;

        browser = await puppeteer.launch({
            browser: browserName,
            executablePath,
            headless: true,
            extraPrefsFirefox: browserName === "firefox" ? {
                "network.proxy.type": 1,
                "network.proxy.http": "127.0.0.1",
                "network.proxy.http_port": 9,
                "network.proxy.ssl": "127.0.0.1",
                "network.proxy.ssl_port": 9,
                "network.proxy.no_proxies_on": [...new Set([
                    "localhost", "127.0.0.1", originHostname
                ])].join(", "),
                "browser.download.folderList": 2,
                "browser.download.dir": downloadDirectory,
                "browser.download.useDownloadDir": true,
                "browser.helperApps.neverAsk.saveToDisk": "application/octet-stream,application/x-uf2"
            } : undefined,
            downloadBehavior: browserName === "firefox" ? undefined : {
                policy: "allow",
                downloadPath: downloadDirectory
            },
            args: browserName === "firefox" ? [] : [
                "--no-sandbox", "--disable-gpu", "--disable-background-networking",
                "--autoplay-policy=no-user-gesture-required"
            ]
        });
        const page = await browser.newPage();
        page.__apiRequests = [];
        page.__apiResponses = [];
        const externalRequests = new Set();
        const localFailures = [];
        const pageErrors = [];
        const consoleErrors = [];
        page.__externalRequests = externalRequests;
        page.__pageErrors = pageErrors;
        page.__consoleErrors = consoleErrors;

        if (browserName !== "firefox") await page.setRequestInterception(true);
        page.on("request", request => {
            const url = request.url();
            if (url.startsWith(`${origin}/api/`)) {
                page.__apiRequests.push({
                    url, method: request.method(),
                    postData: browserName === "firefox" ? undefined : request.postData(),
                    contentType: request.headers()["content-type"]
                });
            }
            const isLocal = url === origin || url.startsWith(`${origin}/`) ||
                /^(?:data|blob|devtools):/.test(url);
            if (!isLocal) {
                externalRequests.add(url);
            }
            if (browserName !== "firefox") {
                if (isLocal) request.continue();
                else request.abort();
            }
        });
        page.on("response", async response => {
            if (!response.url().startsWith(`${origin}/api/`)) return;
            let body;
            try {
                body = await response.text();
            } catch (error) {
                body = `<unavailable: ${error.message}>`;
            }
            page.__apiResponses.push({
                url: response.url(), status: response.status(), body
            });
        });
        page.on("requestfailed", request => {
            if (request.url().startsWith(origin)) {
                const reason = request.failure() && request.failure().errorText;
                if (!/Browsing context already closed/.test(reason || "")) {
                    localFailures.push(`${request.url()}: ${reason}`);
                }
            }
        });
        page.on("response", response => {
            if (response.url().startsWith(origin) && response.status() >= 400) {
                localFailures.push(`${response.url()}: HTTP ${response.status()}`);
            }
        });
        page.on("pageerror", error => pageErrors.push(
            `${error.stack || error.message}\nPage URL: ${page.url()}`));
        page.on("console", message => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });

        await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
        await page.goto(`${origin}/`, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector(".newprojectcard", { timeout: 30000 });
        assert(await page.title() === "Circuit Playground MakeCode", "static editor has the wrong title");

        const manifest = await page.evaluate(async () => {
            const response = await fetch("/sim.webmanifest");
            if (!response.ok) throw new Error(`manifest returned HTTP ${response.status}`);
            const value = await response.json();
            value.iconStatus = await Promise.all((value.icons || []).map(async icon => ({
                src: icon.src,
                type: icon.type,
                status: (await fetch(icon.src)).status
            })));
            return value;
        });
        assert(manifest.name === "Circuit Playground MakeCode", "PWA manifest has the wrong name");
        assert(manifest.iconStatus.length === 2, "PWA manifest must contain two application icons");
        for (const icon of manifest.iconStatus) {
            assert(icon.src.startsWith("/docs/static/icons/android-chrome-"),
                `PWA icon is not release-local: ${icon.src}`);
            assert(icon.type === "image/png" && icon.status === 200,
                `PWA icon is invalid: ${JSON.stringify(icon)}`);
        }

        await checkHomeLayout(page, 1366, 768, "desktop");
        await checkHomeVisuals(page);
        await checkHomeLayout(page, 1024, 600, "Chromebook");
        // 1024x600 at 125% browser zoom has an approximately 819x480 CSS viewport.
        await checkHomeLayout(page, 819, 480, "Chromebook 125% zoom equivalent");
        await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });

        await page.click(".newprojectcard");
        await page.waitForSelector("#projectNameInput");
        const projectName = process.env.CAPTURE_README_SCREENSHOTS === "1"
            ? "Pixel buttons" : "Browser acceptance";
        await page.type("#projectNameInput", projectName);
        await page.evaluate(() => {
            const create = [...document.querySelectorAll("[role=dialog] button")]
                .find(element => element.innerText.trim() === "Create");
            if (!create) throw new Error("Create Project button is missing");
            create.click();
        });
        await page.waitForSelector(
            "[role=dialog] [aria-label=\"Bluefruit\"]",
            { timeout: 30000 }
        );
        const boardChoices = await page.evaluate(() => [...document.querySelectorAll(
            "[role=dialog] [role=button]"
        )].map(element => element.getAttribute("aria-label"))
            .filter(label => label === "Bluefruit" || label === "Express").sort());
        assert(boardChoices.join(",") === "Bluefruit,Express",
        `new-project chooser has unexpected boards: ${boardChoices.join(", ")}`);
        const boardDialog = await page.evaluate(async () => {
            const help = document.querySelector('[role=dialog] a[href="/boards"]');
            const response = help && await fetch(help.getAttribute("href"));
            return {
                text: document.querySelector("[role=dialog]").innerText,
                helpHref: help && help.getAttribute("href"),
                helpStatus: response && response.status,
                helpBody: response && await response.text()
            };
        });
        assert(!/\bBeta\b/.test(boardDialog.text), "hardware chooser still shows Beta badges");
        assert(boardDialog.helpHref === "/boards" && boardDialog.helpStatus === 200 &&
            /<h1>Boards<\/h1>/.test(boardDialog.helpBody || ""),
        `hardware chooser help does not resolve to the boards documentation: ${JSON.stringify(boardDialog)}`);

        await page.click("[role=dialog] [aria-label=\"Bluefruit\"]");
        await page.waitForFunction(() => window.pxt && pxt.appTargetVariant === "nrf52840" &&
            !document.body.classList.contains("ReactModal__Body--open"), { timeout: 30000 });
        await waitForSimulatorBoard(page, "adafruit-circuit-playground-bluefruit");
        await delay(2000);
        const cpbState = await page.evaluate(() => ({
            variant: pxt.appTargetVariant,
            text: document.body.innerText,
            theme: pxt.appTarget.appTheme,
            highContrast: document.body.classList.contains("hc")
        }));
        assert(cpbState.variant === "nrf52840", "CPB project selected the wrong compile variant");
        assert(!/\bNETWORK\b/.test(cpbState.text), "CPB toolbox exposes the CPX-only Network category");
        assert(cpbState.theme.invertedMenu === true && cpbState.theme.invertedToolbox === true &&
            cpbState.theme.invertedMonaco === true && cpbState.theme.baseTheme === "dark" &&
            !cpbState.highContrast,
        "editor did not start with the standard dark theme");
        await auditToolboxContrast(page, "standard CPB theme");

        await clickVisible(page, ".javascript-menuitem");
        await page.waitForFunction(() => window.monaco && monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path)), { timeout: 30000 });
        const marker = "const browserAcceptanceMarker = 314159";
        await page.evaluate(value => {
            const model = monaco.editor.getModels().find(candidate => /main\.ts$/.test(candidate.uri.path));
            model.setValue(`${value}\nlight.setAll(0xff0000)\n`);
        }, marker);
        await delay(2000);
        await captureReadmeScreenshot(page, "editor-bluefruit.png",
            `${marker}\nlight.setAll(0xff0000)\n`);

        const publishedShare = await publishAndReopenProject(
            page, browser, browserName, origin, marker, "nrf52840"
        );
        assert(/^_[23456789A-HJ-NP-Za-km-z]{12}$/.test(publishedShare.id),
            `published project has an invalid ID: ${publishedShare.id}`);
        await clickVisible(page, ".javascript-menuitem");
        await page.waitForFunction(value => window.monaco && monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)),
        { timeout: 30000 }, marker);

        await clickVisible(page, "[title=\"Download options\"]");
        await page.waitForFunction(() => [...document.querySelectorAll("[title=\"Choose Hardware\"]")]
            .some(element => element.getBoundingClientRect().width > 0));
        await clickVisible(page, "[title=\"Choose Hardware\"]");
        await page.waitForSelector(
            "[role=dialog] [aria-label=\"Express\"]",
            { timeout: 30000 }
        );
        await page.click("[role=dialog] [aria-label=\"Express\"]");
        await page.waitForFunction(() => pxt.appTargetVariant === "samd21" &&
            !document.body.classList.contains("ReactModal__Body--open"), { timeout: 30000 });
        await waitForSimulatorBoard(page, "adafruit-circuit-playground-express");
        await delay(2000);

        const cpxState = await page.evaluate(() => ({
            variant: pxt.appTargetVariant,
            text: document.body.innerText,
            source: monaco.editor.getModels().find(model => /main\.ts$/.test(model.uri.path)).getValue()
        }));
        assert(cpxState.variant === "samd21", "CPX board switch selected the wrong compile variant");
        assert(/\bNETWORK\b/.test(cpxState.text), "CPX toolbox is missing its Network category");
        assert(cpxState.source.includes(marker), "board switch did not preserve JavaScript source");
        await captureReadmeScreenshot(page, "editor-express.png",
            `${marker}\nlight.setAll(0xff0000)\n`);

        await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForFunction(() => window.pxt && pxt.appTargetVariant === "samd21" &&
            location.hash === "#editor", { timeout: 30000 });
        await clickVisible(page, ".javascript-menuitem");
        await page.waitForFunction(value => window.monaco && monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)) &&
            /\bNETWORK\b/.test(document.body.innerText),
        { timeout: 30000 }, marker);

        await selectTheme(page, "High Contrast", true);
        await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
        await waitForEditorTheme(page, true);
        await page.evaluate(() => pxt.storage.setLocal("user-pref:colorThemeIds",
            JSON.stringify({ [pxt.appTarget.id]: "removed-theme" })));
        await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
        await waitForEditorTheme(page, false);
        await page.waitForFunction(value => window.monaco && monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)) &&
            /\bNETWORK\b/.test(document.body.innerText),
        { timeout: 30000 }, marker);
        await selectTheme(page, "High Contrast", true);
        await selectTheme(page, "Standard", false);
        await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
        await waitForEditorTheme(page, false);

        await clickVisible(page, ".javascript-menuitem");
        await page.waitForFunction(() => window.monaco && monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path)) &&
            document.body.innerText.includes("browserAcceptanceMarker"),
        { timeout: 30000 });
        const infraredCall = "network.infraredSendNumber(42)";
        await page.evaluate(value => {
            const model = monaco.editor.getModels().find(candidate => /main\.ts$/.test(candidate.uri.path));
            model.setValue(`${model.getValue().trimEnd()}\n${value}\n`);
        }, infraredCall);
        await delay(2000);
        await page.waitForFunction(value => {
            const model = monaco.editor.getModels().find(candidate => /main\.ts$/.test(candidate.uri.path));
            return model && model.getValue().includes(value) &&
                !monaco.editor.getModelMarkers({ resource: model.uri })
                    .some(problem => /infraredSendNumber/.test(problem.message));
        }, { timeout: 30000 }, infraredCall);

        await clickVisible(page, "[title=\"Download options\"]");
        await page.waitForFunction(() => [...document.querySelectorAll("[title=\"Choose Hardware\"]")]
            .some(element => element.getBoundingClientRect().width > 0));
        await clickVisible(page, "[title=\"Choose Hardware\"]");
        await page.waitForSelector(
            "[role=dialog] [aria-label=\"Bluefruit\"]",
            { timeout: 30000 }
        );
        await page.click("[role=dialog] [aria-label=\"Bluefruit\"]");
        await page.waitForFunction(value => pxt.appTargetVariant === "nrf52840" &&
            !document.body.classList.contains("ReactModal__Body--open") &&
            window.monaco && monaco.editor.getModels().some(model =>
                /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)),
        { timeout: 30000 }, infraredCall);
        await clickVisible(page, ".download-button");
        let diagnostic;
        try {
            diagnostic = await page.waitForFunction(() => {
                const problem = monaco.editor.getModelMarkers({})
                    .find(candidate => /infraredSendNumber/.test(candidate.message));
                return problem && {
                    code: `${problem.code || ""}`,
                    message: problem.message,
                    severity: problem.severity
                };
            }, { timeout: 30000 }).then(handle => handle.jsonValue());
        } catch (error) {
            const state = await page.evaluate(() => ({
                bodyText: document.body.innerText,
                markers: monaco.editor.getModelMarkers({}).map(problem => ({
                    code: `${problem.code || ""}`,
                    message: problem.message,
                    owner: problem.owner,
                    resource: problem.resource.toString()
                }))
            }));
            fail(`CPB did not emit the CPX-only API diagnostic: ${JSON.stringify(state)}`);
        }
        assert((!diagnostic.code || diagnostic.code === "2339") && diagnostic.severity === 8 &&
            /does not exist/.test(diagnostic.message),
            `CPB emitted the wrong CPX-only API diagnostic: ${JSON.stringify(diagnostic)}`);
        await page.keyboard.press("Escape");
        const squiggle = await page.waitForFunction(() => {
            const element = [...document.querySelectorAll(".squiggly-error")]
                .find(candidate => candidate.getBoundingClientRect().width > 0);
            if (!element) return false;
            const bounds = element.getBoundingClientRect();
            return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        }, { timeout: 30000 }).then(handle => handle.jsonValue());
        await page.mouse.move(squiggle.x, squiggle.y);
        await page.waitForFunction(() => /infraredSendNumber.*does not exist|does not exist.*infraredSendNumber/s
            .test(document.body.innerText), { timeout: 30000 });
        await page.keyboard.press("Escape");

        await page.evaluate(value => {
            monaco.editor.getModels()
                .filter(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(value))
                .forEach(model => model.setValue(model.getValue().replace(`${value}\n`, "")));
        }, infraredCall);
        await delay(2000);
        await page.waitForFunction(() => {
            return !monaco.editor.getModelMarkers({})
                .some(problem => /infraredSendNumber/.test(problem.message));
        }, { timeout: 30000 });

        await clickVisible(page, "[title=\"Download options\"]");
        await page.waitForFunction(() => [...document.querySelectorAll("[title=\"Choose Hardware\"]")]
            .some(element => element.getBoundingClientRect().width > 0));
        await clickVisible(page, "[title=\"Choose Hardware\"]");
        await page.waitForSelector(
            "[role=dialog] [aria-label=\"Express\"]",
            { timeout: 30000 }
        );
        await page.click("[role=dialog] [aria-label=\"Express\"]");
        await page.waitForFunction(value => pxt.appTargetVariant === "samd21" &&
            !document.body.classList.contains("ReactModal__Body--open") &&
            window.monaco && monaco.editor.getModels().some(model =>
                /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)),
        { timeout: 30000 }, marker);

        await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
        await clickVisible(page, ".blocks-menuitem");
        await page.waitForFunction(() => /set\s+all\s+pixels\s+to/.test(document.body.innerText),
            { timeout: 30000 });
        await checkColorPicker(page, 1280, 750, "Chromebook 80% zoom equivalent");
        await checkColorPicker(page, 1024, 600, "Chromebook");
        await checkColorPicker(page, 819, 480, "Chromebook 125% zoom equivalent");
        await checkColorPicker(page, 512, 300, "Chromebook 200% zoom equivalent");

        await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
        await clickVisible(page, "[title=\"Download options\"]");
        await page.waitForFunction(() => [...document.querySelectorAll("[title=\"Choose Hardware\"]")]
            .some(element => element.getBoundingClientRect().width > 0));
        await clickVisible(page, "[title=\"Choose Hardware\"]");
        await page.waitForSelector(
            "[role=dialog] [aria-label=\"Bluefruit\"]",
            { timeout: 30000 }
        );
        await page.click("[role=dialog] [aria-label=\"Bluefruit\"]");
        await page.waitForFunction(value => pxt.appTargetVariant === "nrf52840" &&
            !document.body.classList.contains("ReactModal__Body--open") &&
            document.body.innerText.includes(value), { timeout: 30000 }, "browserAcceptanceMarker");
        const blocksSwitchState = await page.evaluate(() => ({
            variant: pxt.appTargetVariant,
            text: document.body.innerText
        }));
        assert(!/\bNETWORK\b/.test(blocksSwitchState.text),
            "Blocks-mode switch back to CPB retained the CPX-only Network category");
        assert(/set\s+all\s+pixels\s+to/.test(blocksSwitchState.text),
            "Blocks-mode board switch did not preserve the color block");

        await clickVisible(page, ".javascript-menuitem");
        await page.waitForFunction(() => window.monaco && monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path)) &&
            document.body.innerText.includes("browserAcceptanceMarker"),
        { timeout: 30000 });
        let simulatorFrame = await waitForSimulatorFrame(page);
        await instrumentSimulatorAudio(simulatorFrame);
        const audioMarker = "const browserAudioMarker = 271828";
        const audioProgram = `${marker}\n${audioMarker}\nforever(function () {\n` +
            "    music.playTone(440, 200)\n    pause(20)\n})\n";
        await replaceMonacoSource(page, audioProgram);
        await delay(2000);
        await page.waitForFunction(value => monaco.editor.getModels()
            .some(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)),
        { timeout: 30000 }, audioMarker);
        simulatorFrame = await waitForSimulatorFrame(page);
        await instrumentSimulatorAudio(simulatorFrame);
        simulatorFrame = await restartSimulatorWithAudio(page, simulatorFrame);

        for (let index = 1; index < 10; index++) {
            simulatorFrame = await restartSimulatorWithAudio(page, simulatorFrame);
        }

        for (let index = 0; index < 3; index++) {
            await clickVisible(page, '[title="Home"]');
            await page.waitForSelector(".newprojectcard", { visible: true, timeout: 30000 });
            await openProjectByName(page, projectName);
            await page.waitForFunction(value => window.pxt && pxt.appTargetVariant === "nrf52840" &&
                location.hash === "#editor" && window.monaco && monaco.editor.getModels()
                    .some(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)),
            { timeout: 30000 }, audioMarker);
            simulatorFrame = await waitForSimulatorFrame(page);
            await instrumentSimulatorAudio(simulatorFrame);
            await simulatorFrame.waitForFunction(() => window.__browserAcceptanceAudioInstructions > 0,
                { timeout: 30000 });
        }

        await replaceMonacoSource(page, `${marker}\nlight.setAll(0xff0000)\n`);
        await delay(2000);
        await clickVisible(page, ".blocks-menuitem");
        await page.waitForFunction(() => /set\s+all\s+pixels\s+to/.test(document.body.innerText),
            { timeout: 30000 });

        simulatorFrame = await waitForSimulatorFrame(page);
        await simulatorFrame.waitForFunction(() => window.pxsim && pxsim.runtime &&
            pxsim.runtime.board && pxsim.AudioContextManager, { timeout: 30000 });
        const audioState = await simulatorFrame.evaluate(async () => {
            for (let index = 0; index < 50; index++) {
                pxsim.AudioContextManager.tone(220 + (index % 20) * 20, 0.2);
                await new Promise(resolve => setTimeout(resolve, 4));
                pxsim.AudioContextManager.stopAll();
            }
            const instrument = {
                waveform: 1,
                ampEnvelope: {
                    attack: 1, decay: 1, sustain: 1024, release: 20, amplitude: 1024
                },
                pitchEnvelope: {
                    attack: 0, decay: 0, sustain: 0, release: 0, amplitude: 0
                },
                ampLFO: { frequency: 0, amplitude: 0 },
                pitchLFO: { frequency: 0, amplitude: 0 }
            };
            for (let index = 0; index < 20; index++) {
                const instructions = pxsim.music.renderInstrument(
                    instrument, 330 + index * 5, 250, 100
                );
                const playback = pxsim.AudioContextManager.playInstructionsAsync(instructions);
                await new Promise(resolve => setTimeout(resolve, 4));
                pxsim.AudioContextManager.stopAll();
                await Promise.race([
                    playback,
                    new Promise((resolve, reject) => setTimeout(
                        () => reject(new Error("instruction audio did not cancel")), 1000
                    ))
                ]);
            }
            const sequencerId = await pxsim.music._createSequencer();
            pxsim.AudioContextManager.stopAll();
            const sequencerDisposed = pxsim.music._sequencerState(sequencerId) === undefined;
            pxsim.AudioContextManager.tone(440, 0.2);
            pxsim.runtime.board.kill();
            return {
                frequency: pxsim.AudioContextManager.frequency(),
                active: pxsim.AudioContextManager.isAudioElementActive(),
                sequencerDisposed
            };
        });
        assert(audioState.frequency === 0 && !audioState.active && audioState.sequencerDisposed,
            `simulator audio remained active after teardown: ${JSON.stringify(audioState)}`);

        if (browserName === "firefox") {
            await clickVisible(page, "#settings-menuitem");
            await page.waitForFunction(() => [...document.querySelectorAll('[title="Save Project"]')]
                .some(element => element.getBoundingClientRect().width > 0));
            await clickVisible(page, '[title="Save Project"]');
            const projectPng = await waitForDownload(downloadDirectory, ".png");
            validateProjectPng(projectPng);
            await page.waitForFunction(() => document.body.innerText.includes("Project Saved!"),
                { timeout: 30000 });
            await page.evaluate(() => {
                const button = [...document.querySelectorAll("button")].find(element =>
                    element.getBoundingClientRect().width > 0 &&
                    element.innerText.trim() === "Got it!");
                if (!button) throw new Error("Project Saved dialog has no Got it button");
                button.click();
            });

            await clickVisible(page, '[title="Home"]');
            await page.waitForSelector(".newprojectcard", { visible: true, timeout: 30000 });
            await clickVisible(page, ".import-dialog-btn");
            await page.waitForSelector(
                '[role="button"][aria-label="Open files from your computer"]',
                { visible: true, timeout: 30000 }
            );
            await page.click('[role="button"][aria-label="Open files from your computer"]');
            const fileInput = await page.waitForSelector(
                '[role="dialog"] input[type="file"]', { visible: true, timeout: 30000 }
            );
            await fileInput.uploadFile(projectPng);
            await page.evaluate(() => {
                const buttons = [...document.querySelectorAll('[role="dialog"] button')]
                    .filter(element => element.getBoundingClientRect().width > 0 && !element.disabled);
                const accept = buttons.find(element =>
                    /approve|positive/.test(element.className) || /^(?:OK|Open|Import)$/i.test(element.innerText.trim()));
                if (!accept) {
                    throw new Error(`Import confirmation is missing: ${buttons.map(button =>
                        button.innerText.trim()).join(", ")}`);
                }
                accept.click();
            });
            await page.waitForFunction(value => window.pxt && pxt.appTargetVariant === "nrf52840" &&
                location.hash === "#editor" && document.body.innerText.includes(value) &&
                /set\s+all\s+pixels\s+to/.test(document.body.innerText),
            { timeout: 60000 }, "browserAcceptanceMarker");

            await clickVisible(page, ".download-button");
            const cpbUf2 = await waitForDownload(downloadDirectory, ".uf2");
            validateUf2(cpbUf2, "CPB", 0xada52840, 0x26000, 0xea000);
            fs.renameSync(cpbUf2, `${cpbUf2}.checked`);
            await page.waitForFunction(() => [...document.querySelectorAll("button")]
                .some(element => element.getBoundingClientRect().width > 0 &&
                    element.innerText.trim() === "Done"), { timeout: 30000 });
            await page.evaluate(() => {
                const done = [...document.querySelectorAll("button")]
                    .find(element => element.getBoundingClientRect().width > 0 &&
                        element.innerText.trim() === "Done");
                done.click();
            });
            await page.waitForFunction(() => ![...document.querySelectorAll("button")]
                .some(element => element.getBoundingClientRect().width > 0 &&
                    element.innerText.trim() === "Done"), { timeout: 30000 });
            await delay(3000);
            const repeatedCpbDownloads = fs.readdirSync(downloadDirectory)
                .filter(filename => filename.endsWith(".uf2"));
            for (const filename of repeatedCpbDownloads) {
                const repeatedCpbUf2 = path.join(downloadDirectory, filename);
                validateUf2(repeatedCpbUf2, "repeated CPB", 0xada52840, 0x26000, 0xea000);
                fs.renameSync(repeatedCpbUf2, `${repeatedCpbUf2}.checked`);
            }

            await clickVisible(page, '[title="Download options"]');
            await page.waitForFunction(() => [...document.querySelectorAll('[title="Choose Hardware"]')]
                .some(element => element.getBoundingClientRect().width > 0));
            await clickVisible(page, '[title="Choose Hardware"]');
            await page.waitForSelector(
                '[role=dialog] [aria-label="Express"]',
                { timeout: 30000 }
            );
            await page.click('[role=dialog] [aria-label="Express"]');
            await page.waitForFunction(() => pxt.appTargetVariant === "samd21" &&
                !document.body.classList.contains("ReactModal__Body--open") &&
                /\bNETWORK\b/.test(document.body.innerText) &&
                !/Adding extension/i.test(document.body.innerText) &&
                ![...document.querySelectorAll(".ui.dimmer.active")]
                    .some(element => element.getBoundingClientRect().width > 0),
            { timeout: 30000 });
            let unexpectedUf2 = fs.readdirSync(downloadDirectory)
                .filter(filename => filename.endsWith(".uf2"));
            assert(unexpectedUf2.length === 0,
                `CPX board selection downloaded an unexpected UF2: ${unexpectedUf2.join(", ")}`);
            await clickVisible(page, ".javascript-menuitem");
            await page.waitForFunction(() => window.monaco &&
                document.body.innerText.includes("browserAcceptanceMarker"), { timeout: 30000 });
            const cpxDownloadMarker = "// CPX download acceptance";
            await appendMonacoSource(page, `\n${cpxDownloadMarker}\n`);
            await page.waitForFunction(value => monaco.editor.getModels()
                .some(model => /main\.ts$/.test(model.uri.path) && model.getValue().includes(value)),
            { timeout: 30000 }, cpxDownloadMarker);
            await delay(2000);
            await clickVisible(page, ".blocks-menuitem");
            await page.waitForFunction(() => /set\s+all\s+pixels\s+to/.test(document.body.innerText) &&
                /\bNETWORK\b/.test(document.body.innerText), { timeout: 30000 });
            await delay(2000);
            unexpectedUf2 = fs.readdirSync(downloadDirectory)
                .filter(filename => filename.endsWith(".uf2"));
            assert(unexpectedUf2.length === 0,
                `CPX source conversion downloaded an unexpected UF2: ${unexpectedUf2.join(", ")}`);
            await clickVisible(page, ".download-button");
            const cpxUf2 = await waitForDownload(downloadDirectory, ".uf2");
            validateUf2(cpxUf2, "CPX", 0x68ed2b88, 0x2000, 0x40000);
        }

        assert(externalRequests.size === 0,
            `release made unexpected external requests:\n  ${[...externalRequests].join("\n  ")}`);
        const externalOrigins = [...externalRequests].map(url => new URL(url).origin);
        const isBlockedExternalMessage = message => externalOrigins.some(origin => message.includes(origin));
        const unexpectedPageErrors = pageErrors.filter(message => !isBlockedExternalMessage(message));
        assert(unexpectedPageErrors.length === 0,
            `browser page errors:\n  ${unexpectedPageErrors.join("\n  ")}`);
        assert(localFailures.length === 0, `failed release-local requests:\n  ${localFailures.join("\n  ")}`);
        const unexpectedConsoleErrors = consoleErrors.filter(message =>
            !/Unable to determine region|ERR_BLOCKED_BY_CLIENT/.test(message) &&
            !(externalRequests.size && /Failed to load resource: net::ERR_FAILED/.test(message)) &&
            !isBlockedExternalMessage(message));
        assert(unexpectedConsoleErrors.length === 0,
            `unexpected browser console errors:\n  ${unexpectedConsoleErrors.join("\n  ")}`);
        console.log(`Static browser acceptance: PWA/offline home, responsive layout, reload persistence, JS/Blocks CPB-CPX switching with visible unsupported-API diagnostics, theme selection/startup reset, 80-200% color picker, a user melody across 10 simulator restarts and 3 project reopens, and 50 tone plus 20 instruction-audio cancellations with sequencer teardown${browserName === "firefox" ? ", project export/import, and CPB/CPX UF2 downloads" : ""} passed`);
        console.log(`Browser: ${await browser.version()}`);
        console.log(`Origin: ${origin}`);
        console.log(`External requests: ${externalRequests.size}; console errors: ${consoleErrors.length}`);
    } finally {
        if (browser) await browser.close();
        if (containerId) capture("podman", ["stop", "-t", "1", containerId]);
        fs.rmSync(downloadDirectory, { recursive: true, force: true });
        fs.rmSync(shareDirectory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
