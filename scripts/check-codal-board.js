#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

const workspace = path.resolve(__dirname, "..");
const runtimeDir = path.join(workspace, "codal-circuit-playground-bluefruit");
const pxtConfigPath = path.join(workspace, "pxt-circuit-playground", "libs",
    "adafruit-circuit-playground-bluefruit", "config.ts");
const pxtTargetPath = path.join(workspace, "pxt-circuit-playground", "pxtarget.json");
const bootloaderBoardPath = path.join(workspace, "Adafruit_nRF52_Bootloader", "src", "boards",
    "circuitplayground_nrf52840", "board.h");
const bootloaderMainPath = path.join(workspace, "Adafruit_nRF52_Bootloader", "src", "main.c");
const pxtCommonCore = path.join(workspace, "pxt-circuit-playground", "node_modules",
    "pxt-common-packages", "libs", "core");
const pxtHostPath = path.join(workspace, "pxt-circuit-playground", "node_modules", "pxt-core",
    "built", "pxt.js");
const pxtPlatformPath = path.join(workspace, "pxt-circuit-playground", "libs", "core---nrf52",
    "platform.h");

function fail(message) {
    throw new Error(message);
}

function physicalPin(port, bit, label) {
    const portNumber = Number(port);
    const bitNumber = Number(bit);
    if (!Number.isInteger(portNumber) || !Number.isInteger(bitNumber) ||
        portNumber < 0 || portNumber > 1 || bitNumber < 0 || bitNumber > 31) {
        fail(`${label} has invalid P${port}.${bit}`);
    }
    return portNumber * 32 + bitNumber;
}

function parseCodalPins(source) {
    const result = new Map();
    for (const match of source.matchAll(/\b(CPB_PIN_[A-Z0-9_]+)\s*=\s*P([01])_(\d+)\s*,/g)) {
        result.set(match[1], physicalPin(match[2], match[3], match[1]));
    }
    return result;
}

function parsePxtPins(source) {
    const result = new Map();
    for (const match of source.matchAll(/export const (PIN_[A-Z0-9_]+)\s*=\s*DAL\.P([01])_(\d+)\s*;/g)) {
        result.set(match[1], physicalPin(match[2], match[3], match[1]));
    }
    return result;
}

function requirePins(actual, expected, label) {
    for (const [name, value] of Object.entries(expected)) {
        if (actual.get(name) !== value) {
            fail(`${label} ${name} is ${actual.get(name)}, expected ${value}`);
        }
    }
}

const expectedCodalPins = {
    CPB_PIN_A0: 26,
    CPB_PIN_A1: 2,
    CPB_PIN_A2: 29,
    CPB_PIN_A3: 3,
    CPB_PIN_A4: 4,
    CPB_PIN_A5: 5,
    CPB_PIN_A6: 30,
    CPB_PIN_A7: 14,
    CPB_PIN_NEOPIXEL: 13,
    CPB_PIN_LED: 46,
    CPB_PIN_BUTTON_A: 34,
    CPB_PIN_BUTTON_B: 47,
    CPB_PIN_SLIDE_SWITCH: 38,
    CPB_PIN_SPEAKER: 26,
    CPB_PIN_SPEAKER_AMP: 36,
    CPB_PIN_MIC_DATA: 16,
    CPB_PIN_MIC_CLOCK: 17,
    CPB_PIN_LIGHT: 28,
    CPB_PIN_TEMPERATURE: 31,
    CPB_PIN_ACCELEROMETER_SDA: 42,
    CPB_PIN_ACCELEROMETER_SCL: 44,
    CPB_PIN_ACCELEROMETER_INT: 45,
    CPB_PIN_FLASH_SCK: 19,
    CPB_PIN_FLASH_CS: 15,
    CPB_PIN_FLASH_IO0: 21,
    CPB_PIN_FLASH_IO1: 23,
    CPB_PIN_FLASH_IO2: 32,
    CPB_PIN_FLASH_IO3: 22
};

const expectedPxtPins = {
    PIN_A0: expectedCodalPins.CPB_PIN_A0,
    PIN_A1: expectedCodalPins.CPB_PIN_A1,
    PIN_A2: expectedCodalPins.CPB_PIN_A2,
    PIN_A3: expectedCodalPins.CPB_PIN_A3,
    PIN_A4: expectedCodalPins.CPB_PIN_A4,
    PIN_A5: expectedCodalPins.CPB_PIN_A5,
    PIN_A6: expectedCodalPins.CPB_PIN_A6,
    PIN_A7: expectedCodalPins.CPB_PIN_A7,
    PIN_NEOPIXEL: expectedCodalPins.CPB_PIN_NEOPIXEL,
    PIN_D13: expectedCodalPins.CPB_PIN_LED,
    PIN_BTN_A: expectedCodalPins.CPB_PIN_BUTTON_A,
    PIN_BTN_B: expectedCodalPins.CPB_PIN_BUTTON_B,
    PIN_BTN_SLIDE: expectedCodalPins.CPB_PIN_SLIDE_SWITCH,
    PIN_SPEAKER_AMP: expectedCodalPins.CPB_PIN_SPEAKER_AMP,
    PIN_MIC_DATA: expectedCodalPins.CPB_PIN_MIC_DATA,
    PIN_MIC_CLOCK: expectedCodalPins.CPB_PIN_MIC_CLOCK,
    PIN_LIGHT: expectedCodalPins.CPB_PIN_LIGHT,
    PIN_TEMPERATURE: expectedCodalPins.CPB_PIN_TEMPERATURE,
    PIN_ACCELEROMETER_SDA: expectedCodalPins.CPB_PIN_ACCELEROMETER_SDA,
    PIN_ACCELEROMETER_SCL: expectedCodalPins.CPB_PIN_ACCELEROMETER_SCL,
    PIN_ACCELEROMETER_INT: expectedCodalPins.CPB_PIN_ACCELEROMETER_INT,
    PIN_FLASH_SCK: expectedCodalPins.CPB_PIN_FLASH_SCK,
    PIN_FLASH_CS: expectedCodalPins.CPB_PIN_FLASH_CS,
    PIN_FLASH_MOSI: expectedCodalPins.CPB_PIN_FLASH_IO0,
    PIN_FLASH_MISO: expectedCodalPins.CPB_PIN_FLASH_IO1
};

const pinmap = fs.readFileSync(path.join(runtimeDir, "inc", "device_pinmap.h"), "utf8");
const pxtConfig = fs.readFileSync(pxtConfigPath, "utf8");
const pxtTarget = JSON.parse(fs.readFileSync(pxtTargetPath, "utf8"));
requirePins(parseCodalPins(pinmap), expectedCodalPins, "CODAL");
requirePins(parsePxtPins(pxtConfig), expectedPxtPins, "PXT");

const nrfVariant = pxtTarget.variants && pxtTarget.variants.nrf52840;
if (!nrfVariant || nrfVariant.serial.useHF2 !== true || nrfVariant.compile.webUSB !== true) {
    fail("PXT CPB variant does not enable userspace HF2 and WebUSB");
}
if (nrfVariant.compile.flashEnd !== 0xea000 ||
    String(nrfVariant.compile.uf2Family).toLowerCase() !== "0xada52840") {
    fail("PXT CPB flash ceiling or UF2 family is incorrect");
}
const pxtCodalService = nrfVariant.compileService;
if (pxtCodalService.codalTarget.name !== "codal-circuit-playground-bluefruit" ||
    pxtCodalService.codalBinary !== "CIRCUIT_PLAYGROUND_BLUEFRUIT") {
    fail("PXT CPB variant does not select the CPB CODAL target and binary");
}
if (!/@sha256:[0-9a-f]{64}$/i.test(pxtCodalService.dockerImage)) {
    fail("PXT CPB native toolchain image is not digest-pinned");
}

for (const [alias, target] of [
    ["PIN_JACK_SND", "PIN_A0"],
    ["PIN_LED", "PIN_D13"],
    ["PIN_SCL", "PIN_A4"],
    ["PIN_SDA", "PIN_A5"],
    ["PIN_RX", "PIN_A6"],
    ["PIN_TX", "PIN_A7"]
]) {
    const expression = new RegExp(`export const ${alias}\\s*=\\s*${target}\\s*;`);
    if (!expression.test(pxtConfig)) fail(`PXT ${alias} does not alias ${target}`);
}

const bootloaderBoard = fs.readFileSync(bootloaderBoardPath, "utf8");
for (const [name, port, bit] of [
    ["LED_PRIMARY_PIN", 1, 14],
    ["LED_NEOPIXEL", 0, 13],
    ["BUTTON_DFU", 1, 2],
    ["BUTTON_DFU_OTA", 1, 15]
]) {
    const expression = new RegExp(`#define\\s+${name}\\s+PINNUM\\(${port},\\s*0?${bit}\\)`);
    if (!expression.test(bootloaderBoard)) fail(`bootloader ${name} is not P${port}.${bit}`);
}
for (const [name, value] of [["USB_DESC_VID", "0x239A"], ["USB_DESC_UF2_PID", "0x0045"]]) {
    if (!new RegExp(`#define\\s+${name}\\s+${value}`, "i").test(bootloaderBoard)) {
        fail(`bootloader ${name} is not ${value}`);
    }
}

const runtimeFiles = fs.readdirSync(path.join(runtimeDir, "model"));
if (runtimeFiles.some(name => /BLENano/i.test(name))) fail("legacy BLENano model file remains");
for (const name of runtimeFiles) {
    const source = fs.readFileSync(path.join(runtimeDir, "model", name), "utf8");
    if (/BLENano|BLE_NANO/.test(source)) fail(`legacy BLENano identity remains in model/${name}`);
}

const pxtPlatform = fs.readFileSync(pxtPlatformPath, "utf8");
if (!/#define\s+USB_HANDOVER\s+0\b/.test(pxtPlatform)) {
    fail("PXT nRF52 platform must reject unsupported in-place USB handover");
}

const hf2 = fs.readFileSync(path.join(pxtCommonCore, "hf2.cpp"), "utf8");
const usb = fs.readFileSync(path.join(pxtCommonCore, "usb.cpp"), "utf8");
const pxtCodal = fs.readFileSync(path.join(pxtCommonCore, "codal.cpp"), "utf8");
const pxtHost = fs.readFileSync(pxtHostPath, "utf8");
const bootloaderMain = fs.readFileSync(bootloaderMainPath, "utf8");

for (const [label, source, expression] of [
    ["HF2 vendor interface", hf2, /2,\s*\/\/ numEndpoints[\s\S]*?0xff,[\s\S]*?42,[\s\S]*?1,/],
    ["HF2 userspace BININFO", hf2, /bininfo\.mode\s*=\s*HF2_MODE_USERSPACE/],
    ["HF2 reset-to-bootloader command", hf2, /case\s+HF2_CMD_RESET_INTO_BOOTLOADER:[\s\S]*?NVIC_SystemReset\(\)/],
    ["nRF52840 reset marker address", hf2, /DBL_TAP_PTR\s+\(\(volatile uint32_t \*\)0x20007F7C\)/i],
    ["PXT USB HF2 registration", usb, /usb\.add\(hf2\)/],
    ["PXT application USB VID/PID", usb, /USB_DEFAULT_VID,\s*USB_DEFAULT_PID/]
]) {
    if (!expression.test(source)) fail(`${label} is missing from the installed PXT common core`);
}

const startFlash = pxtHost.indexOf("this.talkAsync(HF2.HF2_CMD_START_FLASH)");
const resetBootloader = pxtHost.indexOf("this.talkAsync(HF2.HF2_CMD_RESET_INTO_BOOTLOADER)", startFlash);
if (startFlash < 0 || resetBootloader < 0 || resetBootloader < startFlash) {
    fail("PXT host no longer falls back from START_FLASH to RESET_INTO_BOOTLOADER");
}

const applicationMarker = /0x([0-9a-f]+),\s*0x\1/i.exec(pxtCodal);
const bootloaderMarker = /APP_ASKS_FOR_SINGLE_TAP_RESET\(\)[^\n]*==\s*0x([0-9a-f]+)/i.exec(bootloaderMain);
if (!applicationMarker || !bootloaderMarker ||
    Number.parseInt(applicationMarker[1], 16) !== Number.parseInt(bootloaderMarker[1], 16)) {
    fail("PXT application marker and bootloader single-reset marker do not agree");
}
if (!/#define\s+DFU_DBL_RESET_MEM\s+0x20007F7C\b/i.test(bootloaderMain)) {
    fail("bootloader double-reset marker is not at the nRF52 PXT reset address");
}

console.log("CPB board contract: 8 pads, sensors, audio, buttons, slide switch, pixels, LED, and QSPI agree");
console.log("CPB shared bootloader contract: LED/buttons/pixels and USB 0x239a:0x0045 agree");
console.log("CPB HF2 handoff contract: userspace WebUSB rejects handover and resets into the bootloader");
