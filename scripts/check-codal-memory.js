#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const workspace = path.resolve(__dirname, "..");
const runtimeDir = path.join(workspace, "codal-circuit-playground-bluefruit");
const expectedDevice = "CIRCUIT_PLAYGROUND_BLUEFRUIT";
const expectedStart = 0x26000;
const expectedEnd = 0xea000;
const expectedLength = expectedEnd - expectedStart;
const expectedBootloaderStart = 0xf4000;
const expectedBootloaderEnd = 0xfd800;
const expectedDependencies = new Map([
    ["codal-core", "1076c9a4388809a4e2c262d62b0064108066ab19"],
    ["codal-nrf52", "04df6d3a15c972ce1c0bd8146737c0bb179db2b7"]
]);
const expectedUsbConfig = new Map([
    ["DEVICE_USB", 1],
    ["DEVICE_USB_ENDPOINTS", 8],
    ["USB_MAX_PKT_SIZE", 64],
    ["USB_EP_FLAG_NO_AUTO_ZLP", 1],
    ["USB_DEFAULT_VID", 0x239a],
    ["USB_DEFAULT_PID", 0x0045],
    ["BOOTLOADER_START_ADDR", expectedBootloaderStart],
    ["BOOTLOADER_END_ADDR", expectedBootloaderEnd]
]);

function fail(message) {
    throw new Error(message);
}

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8"));
}

function parseInteger(value, label) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(parsed)) fail(`${label} is not an integer: ${value}`);
    return parsed;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        ...options
    });
    if (result.error) fail(`${command} could not run: ${result.error.message}`);
    return result;
}

function requireSuccess(result, description) {
    if (result.status !== 0) {
        fail(`${description} failed:\n${result.stdout || ""}${result.stderr || ""}`);
    }
}

function checkTarget(target, label) {
    if (target.device !== expectedDevice) {
        fail(`${label} device is ${target.device}, expected ${expectedDevice}`);
    }
    if (!target.definitions.split(/\s+/).includes(`-D${expectedDevice}`)) {
        fail(`${label} is missing -D${expectedDevice}`);
    }
    const start = parseInteger(target.config.DEVICE_FLASH_START, `${label} DEVICE_FLASH_START`);
    const end = parseInteger(target.config.DEVICE_FLASH_END, `${label} DEVICE_FLASH_END`);
    if (start !== expectedStart || end !== expectedEnd) {
        fail(`${label} flash range is 0x${start.toString(16)}..<0x${end.toString(16)}`);
    }
    for (const [name, expected] of expectedUsbConfig) {
        const actual = parseInteger(target.config[name], `${label} ${name}`);
        if (actual !== expected) {
            fail(`${label} ${name} is 0x${actual.toString(16)}, expected 0x${expected.toString(16)}`);
        }
    }
    const dependencies = new Map(target.libraries.map(dependency => [dependency.name, dependency.branch]));
    for (const [name, expected] of expectedDependencies) {
        if (dependencies.get(name) !== expected) {
            fail(`${label} ${name} revision is ${dependencies.get(name)}, expected ${expected}`);
        }
    }
    if (dependencies.size !== expectedDependencies.size) {
        fail(`${label} has an unexpected dependency set`);
    }
}

const target = readJson("target.json");
const locked = readJson("target-locked.json");
checkTarget(target, "target.json");
checkTarget(locked, "target-locked.json");

for (const dependency of locked.libraries) {
    if (!/^[0-9a-f]{40}$/.test(dependency.branch)) {
        fail(`locked dependency ${dependency.name} is not pinned to a commit`);
    }
}

const cmake = fs.readFileSync(path.join(runtimeDir, "CMakeLists.txt"), "utf8");
for (const expected of [
    "project(codal-circuit-playground-bluefruit)",
    "add_library(codal-circuit-playground-bluefruit",
    "target_include_directories(codal-circuit-playground-bluefruit"
]) {
    if (!cmake.includes(expected)) fail(`CMake target identity is missing: ${expected}`);
}

const linkerPath = path.join(runtimeDir, "ld", "nrf52840.ld");
const linker = fs.readFileSync(linkerPath, "utf8");
const flash = /FLASH\s*\(rx\)\s*:\s*ORIGIN\s*=\s*(0x[0-9a-f]+)\s*,\s*LENGTH\s*=\s*(0x[0-9a-f]+)/i.exec(linker);
if (!flash) fail("could not parse the FLASH region from ld/nrf52840.ld");
const linkerStart = Number(flash[1]);
const linkerLength = Number(flash[2]);
if (linkerStart !== expectedStart || linkerLength !== expectedLength) {
    fail(`linker FLASH is 0x${linkerStart.toString(16)}+0x${linkerLength.toString(16)}`);
}
if (!linker.includes("ASSERT(__flash_image_end <= __application_end")) {
    fail("linker is missing the final flash-image assertion");
}

const bootloaderLinkerPath = path.join(workspace, "Adafruit_nRF52_Bootloader", "linker", "nrf52840.ld");
const bootloaderLinker = fs.readFileSync(bootloaderLinkerPath, "utf8");
const bootloaderFlash = /FLASH\s*\(rx\)\s*:\s*ORIGIN\s*=\s*(0x[0-9a-f]+)\s*,\s*LENGTH\s*=\s*(0x[0-9a-f]+)\s*-\s*(0x[0-9a-f]+)\s*-\s*2K/i.exec(bootloaderLinker);
if (!bootloaderFlash) fail("could not parse the bootloader FLASH region from linker/nrf52840.ld");
const bootloaderStart = Number(bootloaderFlash[1]);
const bootloaderLengthOrigin = Number(bootloaderFlash[3]);
const bootloaderEnd = Number(bootloaderFlash[2]) - 2 * 1024;
if (bootloaderLengthOrigin !== bootloaderStart) {
    fail("bootloader FLASH length is based on a different origin");
}
if (bootloaderStart !== expectedBootloaderStart || bootloaderEnd !== expectedBootloaderEnd) {
    fail(`bootloader FLASH is 0x${bootloaderStart.toString(16)}..<0x${bootloaderEnd.toString(16)}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpb-codal-memory-"));
try {
    const safeObject = path.join(tempDir, "safe.o");
    const safeElf = path.join(tempDir, "safe.elf");
    requireSuccess(run("arm-none-eabi-gcc", [
        "-mcpu=cortex-m4", "-mthumb", "-x", "c", "-c", "-o", safeObject, "-"
    ], { input: "void Reset_Handler(void) {}\n" }), "safe test-object compile");
    requireSuccess(run("arm-none-eabi-ld", ["-T", linkerPath, "-o", safeElf, safeObject]), "safe linker test");

    const symbols = run("arm-none-eabi-nm", ["-n", safeElf]);
    requireSuccess(symbols, "linked-symbol inspection");
    const startSymbol = /^([0-9a-f]+)\s+\w\s+__application_start$/im.exec(symbols.stdout);
    const endSymbol = /^([0-9a-f]+)\s+\w\s+__application_end$/im.exec(symbols.stdout);
    if (!startSymbol || Number.parseInt(startSymbol[1], 16) !== expectedStart) {
        fail("linked __application_start symbol is missing or incorrect");
    }
    if (!endSymbol || Number.parseInt(endSymbol[1], 16) !== expectedEnd) {
        fail("linked __application_end symbol is missing or incorrect");
    }

    const overflowObject = path.join(tempDir, "overflow.o");
    const overflowElf = path.join(tempDir, "overflow.elf");
    requireSuccess(run("arm-none-eabi-gcc", [
        "-mcpu=cortex-m4", "-mthumb", "-x", "assembler", "-c", "-o", overflowObject, "-"
    ], { input: `    .section .text\n    .space 0x${(expectedLength + 1).toString(16)}\n` }), "overflow test-object compile");
    const overflow = run("arm-none-eabi-ld", ["-T", linkerPath, "-o", overflowElf, overflowObject]);
    if (overflow.status === 0) fail("an oversized CPB image linked successfully");
    const overflowOutput = `${overflow.stdout || ""}${overflow.stderr || ""}`;
    if (!overflowOutput.includes("flash image overflowed the CPB application region")) {
        fail(`oversized image failed without the CPB assertion:\n${overflowOutput}`);
    }
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("CPB CODAL contract: CIRCUIT_PLAYGROUND_BLUEFRUIT, flash 0x26000..<0xea000, USB 0x239a:0x0045");
console.log("CPB bootloader contract: code 0xf4000..<0xfd800");
console.log("CPB CODAL overflow contract: oversized image rejected");
