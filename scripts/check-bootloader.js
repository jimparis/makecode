#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

const workspace = path.resolve(__dirname, "..");
const bootloader = path.join(workspace, "Adafruit_nRF52_Bootloader");

function read(relative) {
    return fs.readFileSync(path.join(bootloader, relative), "utf8");
}

function requireMatch(source, expression, message) {
    if (!expression.test(source)) throw new Error(message);
}

const boardCmake = read("src/boards/circuitplayground_nrf52840/board.cmake");
const boardMake = read("src/boards/circuitplayground_nrf52840/board.mk");
const cmake = read("CMakeLists.txt");
const makefile = read("Makefile");
const config = read("src/usb/tusb_config.h");
const descriptor = read("src/usb/usb_desc.c");
const hf2 = read("src/usb/hf2.c");

requireMatch(boardCmake, /set\(MAKECODE_HF2 ON\)/, "CPB CMake does not enable HF2");
requireMatch(boardMake, /^MAKECODE_HF2\s*=\s*1$/m, "CPB Make build does not enable HF2");
requireMatch(cmake, /if \(MAKECODE_HF2\)[\s\S]*src\/usb\/hf2\.c[\s\S]*vendor_device\.c/,
    "CMake does not conditionally include the HF2 vendor driver");
requireMatch(makefile, /ifeq \(\$\(MAKECODE_HF2\), 1\)[\s\S]*src\/usb\/hf2\.c[\s\S]*vendor_device\.c/,
    "Make does not conditionally include the HF2 vendor driver");
requireMatch(config, /#define\s+CFG_TUD_VENDOR\s+1/, "TinyUSB vendor class is not enabled");
requireMatch(descriptor,
    /TUSB_CLASS_VENDOR_SPECIFIC,\s*42,\s*1,[\s\S]*0x04,\s*0x84,\s*64/,
    "HF2 descriptor is not vendor class 255, subclass 42, protocol 1 with 64-byte endpoints");

for (const [expression, message] of [
    [/HF2_FLASH_PAYLOAD_SIZE\s+256u/, "HF2 write payload is not 256 bytes"],
    [/address\s*>=\s*start[\s\S]*address\s*<=\s*end\s*-\s*size/, "HF2 range check is not overflow safe"],
    [/BOOTLOADER_REGION_START\s*-\s*DFU_APP_DATA_RESERVED/, "HF2 does not protect application data"],
    [/DFU_BANK_0_REGION_START/, "HF2 does not start at the SoftDevice application boundary"],
    [/CFG_UF2_FAMILY_APP_ID/, "HF2 BININFO does not advertise the nRF52840 UF2 family"],
    [/bootloader_dfu_activity_mark\(\)/, "HF2 traffic does not keep startup DFU alive"],
    [/hf2_app_vector_valid\(\)/, "HF2 reset does not validate the application vector table"],
    [/flash_nrf5x_flush\(true\)/, "HF2 does not flush its final cached flash page"],
    [/DFU_UPDATE_APP_COMPLETE/, "HF2 does not finalize bootloader application state"]
]) {
    requireMatch(hf2, expression, message);
}

for (const board of ["feather_nrf52840_express", "feather_nrf52832"]) {
    for (const filename of ["board.cmake", "board.mk", "board.h"]) {
        const source = read(`src/boards/${board}/${filename}`);
        if (/MAKECODE_HF2/.test(source)) throw new Error(`${board} unexpectedly enables MakeCode HF2`);
    }
}

console.log("CPB bootloader HF2 contract: class 255/42/1, 256-byte writes, 0x26000..<0xea000 bounds");
console.log("Bootloader isolation contract: MakeCode HF2 is disabled for both Feather regression boards");
