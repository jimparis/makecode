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

function validateUpdateUf2Image(image, label) {
    if (!image.length || image.length % 512) fail(`${label} is not a complete UF2 file`);
    const blockCount = image.length / 512;
    const blockNumbers = new Set();
    const targets = new Map();
    let declaredBlockCount;
    for (let offset = 0; offset < image.length; offset += 512) {
        const start0 = image.readUInt32LE(offset);
        const start1 = image.readUInt32LE(offset + 4);
        const flags = image.readUInt32LE(offset + 8);
        const target = image.readUInt32LE(offset + 12);
        const payload = image.readUInt32LE(offset + 16);
        const blockNumber = image.readUInt32LE(offset + 20);
        const totalBlocks = image.readUInt32LE(offset + 24);
        const family = image.readUInt32LE(offset + 28);
        const end = image.readUInt32LE(offset + 508);
        if (start0 !== 0x0a324655 || start1 !== 0x9e5d5157 || end !== 0x0ab16f30 ||
            flags !== 0x2000 || payload !== 256 || family !== 0xd663823c || (target & 0xff)) {
            fail(`invalid ${label} block at offset ${offset}`);
        }
        const allowed = target < 0x1000 && target + payload <= 0x1000 ||
            (target >= 0xf4000 && target < 0xfe000) ||
            target === 0x10001000;
        if (!allowed) fail(`${label} targets unsafe address 0x${target.toString(16)}`);
        if (blockNumber >= blockCount || blockNumbers.has(blockNumber)) {
            fail(`${label} has an invalid or duplicate block number ${blockNumber}`);
        }
        if (declaredBlockCount === undefined) declaredBlockCount = totalBlocks;
        if (totalBlocks !== declaredBlockCount || targets.has(target)) {
            fail(`${label} has inconsistent counts or duplicate address 0x${target.toString(16)}`);
        }
        blockNumbers.add(blockNumber);
        targets.set(target, image.subarray(offset + 32, offset + 32 + payload));
    }
    if (declaredBlockCount !== blockCount || blockNumbers.size !== blockCount) {
        fail(`${label} is incomplete (${blockNumbers.size}/${declaredBlockCount} blocks)`);
    }
    for (let blockNumber = 0; blockNumber < blockCount; blockNumber++) {
        if (!blockNumbers.has(blockNumber)) fail(`${label} is missing block ${blockNumber}`);
    }

    const vector = targets.get(0xf4000);
    if (!vector) fail(`${label} has no bootloader vector table`);
    const initialStack = vector.readUInt32LE(0);
    const resetVector = vector.readUInt32LE(4);
    if (initialStack < 0x20000000 || initialStack > 0x20040000 || (initialStack & 3) ||
        !(resetVector & 1) || resetVector < 0xf4000 || resetVector >= 0xfe000) {
        fail(`${label} has an invalid bootloader vector table`);
    }

    const uicr = targets.get(0x10001000);
    if (!uicr || uicr.readUInt32LE(0x14) !== 0xf4000 ||
        uicr.readUInt32LE(0x18) !== 0xfe000) {
        fail(`${label} has incompatible UICR bootloader addresses`);
    }

    const config = targets.get(0xfd800);
    if (!config || config.readUInt32LE(0) !== 0x1e9e10f1 ||
        config.readUInt32LE(4) !== 0x20227a79) {
        fail(`${label} has no Circuit Playground bootloader configuration`);
    }
    const usedEntries = config.readUInt32LE(8);
    const totalEntries = config.readUInt32LE(12);
    if (!usedEntries || usedEntries > totalEntries || 16 + usedEntries * 8 > config.length) {
        fail(`${label} has an invalid bootloader configuration table`);
    }
    let boardId;
    for (let entry = 0; entry < usedEntries; entry++) {
        const offset = 16 + entry * 8;
        if (config.readUInt32LE(offset) === 208) boardId = config.readUInt32LE(offset + 4);
    }
    if (boardId !== 0x239a0045) {
        fail(`${label} is not locked to Circuit Playground Bluefruit USB ID 0x239a0045`);
    }

    const sortedTargets = [...targets.keys()].sort((left, right) => left - right);
    const ranges = [];
    let rangeStart = sortedTargets[0];
    let previous = rangeStart;
    for (const target of sortedTargets.slice(1)) {
        if (target !== previous + 256) {
            ranges.push([rangeStart, previous + 256]);
            rangeStart = target;
        }
        previous = target;
    }
    ranges.push([rangeStart, previous + 256]);

    return {
        updateUf2Bytes: image.length,
        updateUf2Blocks: blockCount,
        updateUf2Family: "0xd663823c",
        updateUf2BoardId: "0x239a0045",
        updateUf2TargetRanges: ranges.map(([start, end]) =>
            `0x${start.toString(16)}..<0x${end.toString(16)}`),
        updateUf2MinimumExistingBootloader: "0.4.0",
        updateUf2PreservesSoftDevice: true,
        updateUf2MayOverwriteApplication: true
    };
}

function validateUpdateUf2(filename) {
    const image = fs.readFileSync(filename);
    const contract = validateUpdateUf2Image(image, "bootloader updater");
    const mutations = [
        ["wrong family", 28, 0xada52840],
        ["application address", 12, 0x26000]
    ];
    for (const [name, offset, value] of mutations) {
        const mutated = Buffer.from(image);
        mutated.writeUInt32LE(value, offset);
        let rejected = false;
        try {
            validateUpdateUf2Image(mutated, `mutated updater (${name})`);
        } catch (error) {
            rejected = true;
        }
        if (!rejected) fail(`bootloader updater accepted ${name} mutation`);
    }
    return contract;
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
const updateContract = validateUpdateUf2(path.join(cpbBuild, "bootloader_mbr.uf2"));
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
    [path.join(cpbBuild, "bootloader_mbr.uf2"), "update-circuitplayground_nrf52840_bootloader-makecode-hf2-nosd.uf2"],
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
    ...contract,
    ...updateContract
}, null, 4)}\n`);

console.log(`CPB bootloader artifacts written to ${artifactDir}`);
process.stdout.write(checksums);
