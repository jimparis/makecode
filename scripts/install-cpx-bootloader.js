#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const vm = require("vm");
const { spawnSync } = require("child_process");
const { TextDecoder, TextEncoder } = require("util");

const workspace = path.resolve(__dirname, "..");
const artifact = path.join(workspace, "artifacts", "cpx-bootloader",
    "update-circuit-playground-express-bootloader-v4.0.0.uf2");
const metadataFile = path.join(workspace, "artifacts", "cpx-bootloader", "metadata.json");
const pxtLibrary = path.join(workspace, "pxt", "built", "pxtlib.js");

function fail(message) { throw new Error(message); }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

function udevProperties(device) {
    const result = spawnSync("udevadm", ["info", "--query=property", "--name", device], {
        encoding: "utf8",
    });
    if (result.status !== 0) return undefined;
    return Object.fromEntries(result.stdout.trim().split(/\n/)
        .map(line => line.split(/=(.*)/s).slice(0, 2))
        .filter(parts => parts.length === 2));
}

function findCpxHidDevices() {
    return fs.readdirSync("/dev").filter(name => /^hidraw\d+$/.test(name))
        .map(name => `/dev/${name}`)
        .map(device => ({ device, properties: udevProperties(device) }))
        .filter(entry => entry.properties?.ID_VENDOR_ID === "239a" &&
            entry.properties?.ID_MODEL_ID === "0018");
}

function validateUpdater() {
    if (!fs.existsSync(artifact) || !fs.existsSync(metadataFile)) {
        fail("missing updater; run `make cpx-bootloader-build`");
    }
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    const image = fs.readFileSync(artifact);
    if (!metadata.officialAdafruitSource || metadata.sourceVersion !== "v4.0.0" ||
        metadata.board !== "circuitplay_m0" || metadata.updater?.sha256 !== sha256(image) ||
        metadata.updater?.updaterWritesBootloaderRange !== "0x0..<0x2000" ||
        !metadata.updater?.updaterRestoresBootProtection) {
        fail("updater does not match its validated official-source metadata");
    }
    if (!image.length || image.length % 512) fail("updater is not a complete UF2 file");
    const blocks = [];
    for (let offset = 0; offset < image.length; offset += 512) {
        const target = image.readUInt32LE(offset + 12);
        const size = image.readUInt32LE(offset + 16);
        const number = image.readUInt32LE(offset + 20);
        const total = image.readUInt32LE(offset + 24);
        if (image.readUInt32LE(offset) !== 0x0a324655 ||
            image.readUInt32LE(offset + 4) !== 0x9e5d5157 ||
            image.readUInt32LE(offset + 508) !== 0x0ab16f30 ||
            image.readUInt32LE(offset + 8) !== 0 || size !== 256 ||
            number !== blocks.length || total !== image.length / 512 ||
            target !== 0x2000 + number * 256 || target + size > 0x40000) {
            fail(`unsafe or invalid updater block ${number}`);
        }
        blocks.push({ target, data: Buffer.from(image.subarray(offset + 32, offset + 288)) });
    }
    return { blocks, hash: sha256(image) };
}

function loadPxt() {
    if (!fs.existsSync(pxtLibrary)) fail("missing PXT build; run `make pxt-core-build`");
    const context = {
        console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer,
        process, require, TextDecoder, TextEncoder, module: { exports: {} }, exports: {},
    };
    context.global = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(pxtLibrary, "utf8"), context, { filename: pxtLibrary });
    context.window = { crypto: crypto.webcrypto };
    context.pxt.appTarget = { appTheme: {}, compile: {} };
    return context.pxt;
}

class RawHidIO {
    constructor(device) {
        this.fd = fs.openSync(device, fs.constants.O_RDWR);
        this.connected = true;
        this.onDeviceConnectionChanged = () => { };
        this.onConnectionChanged = () => { };
        this.onData = () => { };
        this.onEvent = () => { };
        this.onError = () => { };
        this.readLoop();
    }
    readLoop() {
        const buffer = Buffer.alloc(64);
        fs.read(this.fd, buffer, 0, buffer.length, null, (error, bytes) => {
            if (error) { if (this.connected) this.onError(error); return; }
            if (bytes) this.onData(new Uint8Array(buffer.subarray(0, bytes)));
            if (this.connected) this.readLoop();
        });
    }
    isConnecting() { return false; }
    isConnected() { return this.connected; }
    reconnectAsync() { return Promise.resolve(); }
    disconnectAsync() { return Promise.resolve(); }
    disposeAsync() { return Promise.resolve(); }
    error(message) { fail(message); }
    stop() { this.connected = false; }
    sendPacketAsync(packet) {
        const report = Buffer.alloc(65);
        Buffer.from(packet).copy(report, 1);
        return new Promise((resolve, reject) => {
            fs.write(this.fd, report, 0, report.length, null, (error, bytes) => {
                if (error) reject(error);
                else if (bytes !== report.length) reject(new Error(`short HID write: ${bytes}`));
                else resolve();
            });
        });
    }
}

async function connect(pxt, device) {
    const io = new RawHidIO(device);
    const hf2 = new pxt.HF2.Wrapper(io);
    try { await hf2.reconnectAsync(); return { hf2, io }; }
    catch (error) { io.stop(); throw error; }
}

function validateCpx(hf2) {
    if (!hf2.bootloaderMode || hf2.pageSize !== 256 || hf2.flashSize !== 0x40000 ||
        !/Board-ID:\s*SAMD21G18A-CPlay-v0\b/.test(hf2.infoRaw || "")) {
        fail("the connected HID device is not a compatible Circuit Playground Express");
    }
}

async function confirmInstall(info) {
    console.log("\nThis update erases the program currently stored on the CPX.");
    console.log("Save that program before continuing and keep the USB cable connected.");
    console.log(`\nCurrent bootloader:\n${info.trim()}\n`);
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail("run this installer from a terminal");
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("Type INSTALL CPX V4 to continue: ");
    prompt.close();
    if (answer !== "INSTALL CPX V4") fail("installation cancelled");
}

async function writeAndVerify(pxt, hf2, blocks) {
    for (const [index, block] of blocks.entries()) {
        const payload = Buffer.alloc(260);
        payload.writeUInt32LE(block.target, 0);
        block.data.copy(payload, 4);
        await hf2.talkAsync(pxt.HF2.HF2_CMD_WRITE_FLASH_PAGE, new Uint8Array(payload));
        if ((index + 1) % 10 === 0 || index === blocks.length - 1)
            console.log(`Wrote ${index + 1}/${blocks.length} updater pages`);
    }
    for (const [index, block] of blocks.entries()) {
        const actual = Buffer.from(await hf2.readWordsAsync(block.target, 64));
        if (!actual.equals(block.data)) fail(`readback failed at 0x${block.target.toString(16)}`);
        if ((index + 1) % 10 === 0 || index === blocks.length - 1)
            console.log(`Verified ${index + 1}/${blocks.length} updater pages`);
    }
}

async function verifyV4(pxt) {
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
        await delay(500);
        for (const entry of findCpxHidDevices()) {
            try {
                const { hf2, io } = await connect(pxt, entry.device);
                validateCpx(hf2);
                if (/UF2 Bootloader v4\.0\.0\b/.test(hf2.infoRaw || "") &&
                    hf2.familyID === 0x68ed2b88) {
                    console.log(`\nVerified new bootloader:\n${hf2.infoRaw.trim()}`);
                    console.log(`USB serial: ${entry.properties.ID_SERIAL_SHORT || "present"}`);
                    io.stop();
                    return;
                }
                io.stop();
            } catch (error) { lastError = error; }
        }
    }
    fail(`CPX did not reconnect as v4.0.0${lastError ? `: ${lastError.message}` : ""}`);
}

async function main() {
    const updater = validateUpdater();
    const devices = findCpxHidDevices();
    if (devices.length !== 1) fail(`expected exactly one CPX USB device; found ${devices.length}`);
    const pxt = loadPxt();
    const { hf2, io } = await connect(pxt, devices[0].device);
    validateCpx(hf2);
    console.log(hf2.infoRaw.trim());
    console.log(`Updater SHA-256: ${updater.hash}`);
    if (/UF2 Bootloader v4\.0\.0\b/.test(hf2.infoRaw || "") &&
        hf2.familyID === 0x68ed2b88) {
        console.log("This CPX already has the expected v4.0.0 bootloader; nothing was written.");
        io.stop();
        return;
    }
    await confirmInstall(hf2.infoRaw);
    await writeAndVerify(pxt, hf2, updater.blocks);
    console.log("All pages match; starting the updater now...");
    try { await hf2.talkAsync(pxt.HF2.HF2_CMD_RESET_INTO_APP); } catch (error) { }
    io.stop();
    await verifyV4(pxt);
}

main().then(() => setTimeout(() => process.exit(0), 100), error => {
    console.error(`CPX bootloader installer: ${error.message}`);
    setTimeout(() => process.exit(1), 100);
});
