#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const workspace = path.resolve(__dirname, "..");
const sourceDir = path.join(workspace, "Adafruit_nRF52_Bootloader");
const artifactDir = path.join(workspace, "artifacts", "bootloader");
const venvDir = path.join(workspace, "artifacts", "bootloader-venv");
const python = path.join(venvDir, "bin", "python");
const boards = [
    "circuitplayground_nrf52840",
    "feather_nrf52840_express",
    "feather_nrf52832"
];
const topLevelSubmodules = ["lib/nrfx", "lib/tinycrypt", "lib/tinyusb", "lib/uf2"];

function fail(message) {
    throw new Error(message);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: "inherit",
        ...options
    });
    if (result.error) fail(`${command} could not run: ${result.error.message}`);
    if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

function capture(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: sourceDir,
        encoding: "utf8",
        ...options
    });
    if (result.error) fail(`${command} could not run: ${result.error.message}`);
    if (result.status !== 0) {
        fail(`${command} exited with status ${result.status}:\n${result.stdout || ""}${result.stderr || ""}`);
    }
    return result.stdout.trim();
}

function sha256(filename) {
    return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function intelHexAddresses(filename) {
    let base = 0;
    const addresses = [];
    for (const line of fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)) {
        if (!/^:[0-9a-f]+$/i.test(line)) fail(`invalid Intel HEX record in ${filename}`);
        const length = Number.parseInt(line.slice(1, 3), 16);
        const offset = Number.parseInt(line.slice(3, 7), 16);
        const type = Number.parseInt(line.slice(7, 9), 16);
        const bytes = Buffer.from(line.slice(9, 9 + length * 2), "hex");
        const checksum = Number.parseInt(line.slice(9 + length * 2, 11 + length * 2), 16);
        let sum = length + (offset >> 8) + (offset & 0xff) + type + checksum;
        for (const byte of bytes) sum += byte;
        if ((sum & 0xff) !== 0) fail(`bad Intel HEX checksum in ${filename}`);
        if (type === 0) {
            for (let i = 0; i < length; i++) addresses.push(base + offset + i);
        } else if (type === 2) {
            base = bytes.readUInt16BE(0) << 4;
        } else if (type === 4) {
            base = bytes.readUInt16BE(0) * 0x10000;
        }
    }
    return addresses;
}

function validateUpdateUf2(filename) {
    const image = fs.readFileSync(filename);
    if (!image.length || image.length % 512) fail("bootloader update is not a complete UF2 file");
    for (let offset = 0; offset < image.length; offset += 512) {
        const start0 = image.readUInt32LE(offset);
        const start1 = image.readUInt32LE(offset + 4);
        const flags = image.readUInt32LE(offset + 8);
        const target = image.readUInt32LE(offset + 12);
        const payload = image.readUInt32LE(offset + 16);
        const family = image.readUInt32LE(offset + 28);
        const end = image.readUInt32LE(offset + 508);
        if (start0 !== 0x0a324655 || start1 !== 0x9e5d5157 || end !== 0x0ab16f30 ||
            !(flags & 0x2000) || payload !== 256 || family !== 0xd663823c) {
            fail(`invalid bootloader UF2 block at offset ${offset}`);
        }
        const allowed = target < 0x1000 ||
            (target >= 0xf4000 && target < 0xfe000) ||
            target === 0x10001000;
        if (!allowed) fail(`bootloader updater targets unsafe address 0x${target.toString(16)}`);
    }
}

function validateCpbBuild(buildDir) {
    const hex = path.join(buildDir, "bootloader.hex");
    const addresses = intelHexAddresses(hex);
    const ordinary = addresses.filter(address => address < 0x10000000);
    const uicr = addresses.filter(address => address >= 0x10000000);
    if (!ordinary.length || Math.min(...ordinary) !== 0xf4000 || Math.max(...ordinary) >= 0xfd858) {
        fail("CPB bootloader HEX escaped its code/config regions");
    }
    if (uicr.some(address => address < 0x10001014 || address >= 0x1000101c)) {
        fail("CPB bootloader HEX contains unexpected UICR data");
    }

    const binary = path.join(buildDir, "bootloader.bin");
    const image = Buffer.alloc(0x10000);
    const binaryFd = fs.openSync(binary, "r");
    const imageSize = fs.readSync(binaryFd, image, 0, image.length, 0);
    fs.closeSync(binaryFd);
    const loadedImage = image.subarray(0, imageSize);
    for (const interfaceNumber of [2, 3]) {
        const descriptor = Buffer.from([
            9, 4, interfaceNumber, 0, 2, 255, 42, 1, 6,
            7, 5, 4, 2, 64, 0, 0,
            7, 5, 132, 2, 64, 0, 0
        ]);
        if (loadedImage.indexOf(descriptor) < 0) {
            fail(`CPB image is missing HF2 interface ${interfaceNumber}`);
        }
    }

    const applicationEnd = 0xea000;
    const codeEnd = Math.max(...ordinary.filter(address => address < 0xfd800)) + 1;
    return {
        applicationStart: "0x26000",
        applicationEnd: `0x${applicationEnd.toString(16)}`,
        bootloaderStart: "0xf4000",
        bootloaderCodeEnd: `0x${codeEnd.toString(16)}`,
        bootloaderCodeLimit: "0xfd800",
        bootloaderHeadroom: 0xfd800 - codeEnd,
        hf2Interfaces: [2, 3]
    };
}

run("node", [path.join(workspace, "scripts", "check-bootloader.js")]);
run("git", ["submodule", "update", "--init", "--", ...topLevelSubmodules]);

const submodules = {};
for (const relative of topLevelSubmodules) {
    const expected = capture("git", ["ls-tree", "HEAD", relative]).split(/\s+/)[2];
    const actual = capture("git", ["-C", relative, "rev-parse", "HEAD"]);
    if (!expected || actual !== expected) fail(`${relative} is ${actual}, expected ${expected}`);
    submodules[relative] = actual;
}

if (!fs.existsSync(python)) run("python3", ["-m", "venv", venvDir], { cwd: workspace });
const intelHex = spawnSync(python, ["-c", "import intelhex"], { encoding: "utf8" });
if (intelHex.status !== 0) run(python, ["-m", "pip", "install", "intelhex==2.3.0"], { cwd: workspace });

const sourceDateEpoch = capture("git", ["show", "-s", "--format=%ct", "HEAD"]);
const buildEnvironment = { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch };
const buildDirs = new Map();
for (const board of boards) {
    const buildDir = path.join(artifactDir, `build-${board}`);
    buildDirs.set(board, buildDir);
    fs.mkdirSync(buildDir, { recursive: true });
    run("cmake", [
        "-S", ".", "-B", buildDir,
        `-DBOARD=${board}`,
        "-DCMAKE_BUILD_TYPE=MinSizeRel",
        `-DPython_EXECUTABLE=${python}`
    ], { env: buildEnvironment });
    run("cmake", ["--build", buildDir, "--clean-first", "--parallel", "4"], {
        env: buildEnvironment
    });
}

const cpbBuild = buildDirs.get("circuitplayground_nrf52840");
const contract = validateCpbBuild(cpbBuild);
validateUpdateUf2(path.join(cpbBuild, "bootloader_mbr.uf2"));
fs.mkdirSync(artifactDir, { recursive: true });

const recoveryHex = path.join(artifactDir, "circuitplayground_nrf52840-recovery-s140-6.1.1.hex");
run(python, [
    path.join(sourceDir, "tools", "hexmerge.py"),
    "-o", recoveryHex,
    path.join(cpbBuild, "bootloader.hex"),
    path.join(sourceDir, "lib", "softdevice", "s140_nrf52_6.1.1",
        "s140_nrf52_6.1.1_softdevice.hex")
], { cwd: workspace, env: buildEnvironment });
const recoveryAddresses = intelHexAddresses(recoveryHex);
for (const required of [0, 0xf4000, 0x10001014, 0x10001018]) {
    if (!recoveryAddresses.includes(required)) {
        fail(`SWD recovery image is missing address 0x${required.toString(16)}`);
    }
}

const outputs = [
    [path.join(cpbBuild, "bootloader.elf"), "circuitplayground_nrf52840-bootloader.elf"],
    [path.join(cpbBuild, "bootloader.hex"), "circuitplayground_nrf52840-bootloader.hex"],
    [path.join(cpbBuild, "bootloader_mbr.uf2"), "circuitplayground_nrf52840-bootloader-update.uf2"],
    [recoveryHex, path.basename(recoveryHex)]
];
for (const [source, name] of outputs) {
    const destination = path.join(artifactDir, name);
    if (source !== destination) fs.copyFileSync(source, destination);
}

const checksums = outputs
    .map(([, name]) => `${sha256(path.join(artifactDir, name))}  ${name}`)
    .join("\n") + "\n";
fs.writeFileSync(path.join(artifactDir, "SHA256SUMS"), checksums);
fs.writeFileSync(path.join(artifactDir, "BUILD-METADATA.json"), `${JSON.stringify({
    sourceCommit: capture("git", ["rev-parse", "HEAD"]),
    sourceDirty: capture("git", ["status", "--porcelain"]).length > 0,
    sourceDateEpoch,
    submodules,
    intelhex: "2.3.0",
    cmake: capture("cmake", ["--version"]).split("\n")[0],
    compiler: capture("arm-none-eabi-gcc", ["--version"]).split("\n")[0],
    regressionBoards: boards.slice(1),
    ...contract
}, null, 4)}\n`);

console.log(`CPB bootloader artifacts written to ${artifactDir}`);
process.stdout.write(checksums);
