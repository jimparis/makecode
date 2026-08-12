#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const workspace = path.resolve(__dirname, "..");
const sourceDir = path.join(workspace, "uf2-samdx1");
const artifactDir = path.join(workspace, "artifacts", "cpx-bootloader");
const toolchainDir = path.join(workspace, "artifacts", "toolchains");
const toolchainName = "arm-gnu-toolchain-14.3.rel1-x86_64-arm-none-eabi";
const toolchainArchive = path.join(toolchainDir, `${toolchainName}.tar.xz`);
const toolchainRoot = path.join(toolchainDir, toolchainName);
const toolchainUrl = "https://developer.arm.com/-/media/Files/downloads/gnu/14.3.rel1/binrel/arm-gnu-toolchain-14.3.rel1-x86_64-arm-none-eabi.tar.xz";
const toolchainSha256 = "8f6903f8ceb084d9227b9ef991490413014d991874a1e34074443c2a72b14dbd";
const board = "circuitplay_m0";
const bootloaderSize = 0x2000;
const applicationEnd = 0x40000;

function fail(message) {
    throw new Error(message);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: "inherit",
        ...options,
    });
    if (result.error) fail(`${command} could not run: ${result.error.message}`);
    if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

function capture(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: sourceDir,
        encoding: "utf8",
        ...options,
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

function ensureToolchain() {
    fs.mkdirSync(toolchainDir, { recursive: true });
    if (!fs.existsSync(toolchainArchive)) {
        run("curl", ["--fail", "--location", "--output", toolchainArchive, toolchainUrl], {
            cwd: workspace,
        });
    }
    const actualHash = sha256(toolchainArchive);
    if (actualHash !== toolchainSha256) {
        fail(`Arm toolchain archive has SHA-256 ${actualHash}, expected ${toolchainSha256}`);
    }

    const compiler = path.join(toolchainRoot, "bin", "arm-none-eabi-gcc");
    if (!fs.existsSync(compiler)) {
        fs.rmSync(toolchainRoot, { recursive: true, force: true });
        run("tar", ["-xJf", toolchainArchive, "-C", toolchainDir], { cwd: workspace });
    }
    if (!fs.existsSync(compiler)) fail("Arm toolchain extraction did not produce the compiler");
    return compiler;
}

function verifySource() {
    if (capture("git", ["status", "--porcelain"])) fail("uf2-samdx1 has uncommitted changes");
    const expectedUf2 = capture("git", ["ls-tree", "HEAD", "lib/uf2"]).split(/\s+/)[2];
    const actualUf2 = capture("git", ["-C", "lib/uf2", "rev-parse", "HEAD"]);
    if (!expectedUf2 || expectedUf2 !== actualUf2) {
        fail(`uf2-samdx1/lib/uf2 is ${actualUf2}, expected ${expectedUf2}`);
    }
    if (capture("git", ["-C", "lib/uf2", "status", "--porcelain"])) {
        fail("uf2-samdx1/lib/uf2 has uncommitted changes");
    }

    const updaterSource = fs.readFileSync(path.join(sourceDir, "src", "selfmain.c"), "utf8");
    for (const required of [
        "set_fuses_and_bootprot(7)",
        "for (uint32_t i = 0; i < BOOTLOADER_K * 1024; i += FLASH_ROW_SIZE)",
        "flash_write_row((void *)i",
        "set_fuses_and_bootprot(2)",
        "resetIntoBootloader()",
    ]) {
        if (!updaterSource.includes(required)) fail(`CPX updater source is missing contract: ${required}`);
    }

    const usbSource = fs.readFileSync(path.join(sourceDir, "src", "cdc_enumerate.c"), "utf8");
    for (const required of ["0x0080A00C", "0x0080A040", "0x0080A044", "0x0080A048"]) {
        if (!usbSource.includes(required)) fail(`CPX USB source is missing serial source ${required}`);
    }
}

function findSequence(image, bytes, description) {
    if (image.indexOf(Buffer.from(bytes)) < 0) fail(`CPX bootloader is missing ${description}`);
}

function validateBootloader(filename) {
    const image = fs.readFileSync(filename);
    if (image.length !== bootloaderSize) {
        fail(`CPX bootloader is ${image.length} bytes, expected exactly ${bootloaderSize}`);
    }
    const initialStack = image.readUInt32LE(0);
    const resetVector = image.readUInt32LE(4);
    if (initialStack < 0x20000000 || initialStack > 0x20008000 || (initialStack & 3) ||
        !(resetVector & 1) || resetVector >= bootloaderSize) {
        fail("CPX bootloader has an invalid vector table");
    }

    findSequence(image, [
        0x12, 0x01, 0x10, 0x02, 0xef, 0x02, 0x01, 0x40,
        0x9a, 0x23, 0x18, 0x00, 0x01, 0x42, 0x01, 0x02, 0x03, 0x01,
    ], "USB device descriptor with a persistent serial number");
    findSequence(image, [0x09, 0x04, 0x03, 0x00, 0x02, 0x03, 0x00, 0x00, 0x03],
        "HID interface");
    findSequence(image, [0x09, 0x04, 0x04, 0x00, 0x02, 0xff, 0x2a, 0x01, 0x00],
        "HF2 WebUSB interface");
    findSequence(image, [
        0x38, 0xb6, 0x08, 0x34, 0xa9, 0x09, 0xa0, 0x47,
        0x8b, 0xfd, 0xa0, 0x76, 0x88, 0x15, 0xb6, 0x65,
    ], "WebUSB platform capability");

    return {
        bootloaderBytes: image.length,
        bootloaderStart: "0x0",
        applicationStart: "0x2000",
        applicationEnd: `0x${applicationEnd.toString(16)}`,
        usbVidPid: "239a:0018",
        usbSerial: "hardware-derived 32-character serial",
        usbInterfaces: ["CDC", "MSC UF2", "HID", "HF2 WebUSB"],
    };
}

function validateUpdaterImage(image, label) {
    if (!image.length || image.length % 512) fail(`${label} is not a complete UF2 file`);
    const physicalBlocks = image.length / 512;
    const blocks = new Map();
    let declaredBlocks;
    for (let offset = 0; offset < image.length; offset += 512) {
        const magic0 = image.readUInt32LE(offset);
        const magic1 = image.readUInt32LE(offset + 4);
        const flags = image.readUInt32LE(offset + 8);
        const target = image.readUInt32LE(offset + 12);
        const payloadSize = image.readUInt32LE(offset + 16);
        const blockNumber = image.readUInt32LE(offset + 20);
        const totalBlocks = image.readUInt32LE(offset + 24);
        const endMagic = image.readUInt32LE(offset + 508);
        if (magic0 !== 0x0a324655 || magic1 !== 0x9e5d5157 || endMagic !== 0x0ab16f30 ||
            flags !== 0 || payloadSize !== 256 || (target & 0xff)) {
            fail(`${label} has an invalid UF2 block at offset ${offset}`);
        }
        if (target < bootloaderSize || target + payloadSize > applicationEnd) {
            fail(`${label} targets unsafe address 0x${target.toString(16)}`);
        }
        if (blockNumber >= physicalBlocks || blocks.has(blockNumber)) {
            fail(`${label} has invalid or duplicate block ${blockNumber}`);
        }
        if (declaredBlocks === undefined) declaredBlocks = totalBlocks;
        if (totalBlocks !== declaredBlocks) fail(`${label} has inconsistent block counts`);
        blocks.set(blockNumber, {
            target,
            data: image.subarray(offset + 32, offset + 32 + payloadSize),
        });
    }
    if (declaredBlocks !== physicalBlocks || blocks.size !== physicalBlocks) {
        fail(`${label} is incomplete (${blocks.size}/${declaredBlocks} blocks)`);
    }

    const ordered = [];
    for (let number = 0; number < declaredBlocks; number++) {
        const block = blocks.get(number);
        if (!block) fail(`${label} is missing block ${number}`);
        if (block.target !== bootloaderSize + number * 256) {
            fail(`${label} is not contiguous at block ${number}`);
        }
        ordered.push(block.data);
    }
    const application = Buffer.concat(ordered);
    const initialStack = application.readUInt32LE(0);
    const resetVector = application.readUInt32LE(4);
    if (initialStack < 0x20000000 || initialStack > 0x20008000 || (initialStack & 3) ||
        !(resetVector & 1) || resetVector < bootloaderSize || resetVector >= applicationEnd) {
        fail(`${label} has an invalid self-updater vector table`);
    }

    return {
        updaterUf2Bytes: image.length,
        updaterUf2Blocks: physicalBlocks,
        updaterTargetRange: `0x${bootloaderSize.toString(16)}..<0x${(bootloaderSize + physicalBlocks * 256).toString(16)}`,
        updaterMayOverwriteApplication: true,
        updaterWritesBootloaderRange: "0x0..<0x2000",
        updaterRestoresBootProtection: true,
    };
}

function validateUpdater(filename) {
    const image = fs.readFileSync(filename);
    const contract = validateUpdaterImage(image, "CPX bootloader updater");
    const mutations = [
        ["bootloader target", 12, 0],
        ["duplicate block", 20 + 512, 0],
    ];
    for (const [description, offset, value] of mutations) {
        const mutated = Buffer.from(image);
        mutated.writeUInt32LE(value, offset);
        let rejected = false;
        try {
            validateUpdaterImage(mutated, `mutated updater (${description})`);
        } catch (error) {
            rejected = true;
        }
        if (!rejected) fail(`CPX updater accepted ${description} mutation`);
    }
    let rejected = false;
    try {
        validateUpdaterImage(image.subarray(0, image.length - 512), "truncated updater");
    } catch (error) {
        rejected = true;
    }
    if (!rejected) fail("CPX updater accepted a truncated image");
    return contract;
}

verifySource();
const compiler = ensureToolchain();
const sourceCommit = capture("git", ["rev-parse", "HEAD"]);
const sourceVersion = capture("git", ["describe", "--tags", "--always"]);
const uf2Commit = capture("git", ["-C", "lib/uf2", "rev-parse", "HEAD"]);
const sourceDateEpoch = capture("git", ["show", "-s", "--format=%ct", "HEAD"]);
const buildEnvironment = {
    ...process.env,
    PATH: `${path.dirname(compiler)}:${process.env.PATH}`,
    SOURCE_DATE_EPOCH: sourceDateEpoch,
    TZ: "UTC",
    LC_ALL: "C",
    LANG: "C",
};

fs.rmSync(path.join(sourceDir, "build", board), { recursive: true, force: true });
run("make", [`BOARD=${board}`, "--jobs=4"], { env: buildEnvironment });

const buildDir = path.join(sourceDir, "build", board);
const sourceBootloader = path.join(buildDir, `bootloader-${board}-${sourceVersion}.bin`);
const sourceUpdater = path.join(buildDir, `update-bootloader-${board}-${sourceVersion}.uf2`);
if (!fs.existsSync(sourceBootloader) || !fs.existsSync(sourceUpdater)) {
    fail(`CPX build did not produce the expected ${sourceVersion} outputs`);
}
const bootloaderContract = validateBootloader(sourceBootloader);
const updaterContract = validateUpdater(sourceUpdater);

fs.mkdirSync(artifactDir, { recursive: true });
const bootloaderName = `circuit-playground-express-bootloader-${sourceVersion}.bin`;
const updaterName = `update-circuit-playground-express-bootloader-${sourceVersion}.uf2`;
const artifactBootloader = path.join(artifactDir, bootloaderName);
const artifactUpdater = path.join(artifactDir, updaterName);
fs.copyFileSync(sourceBootloader, artifactBootloader);
fs.copyFileSync(sourceUpdater, artifactUpdater);

const metadata = {
    sourceRepository: "https://github.com/adafruit/uf2-samdx1",
    sourceCommit,
    sourceVersion,
    sourceDirty: false,
    uf2LibraryCommit: uf2Commit,
    board,
    officialAdafruitSource: true,
    toolchain: {
        url: toolchainUrl,
        sha256: toolchainSha256,
        version: capture(compiler, ["--version"], { cwd: workspace }).split(/\r?\n/)[0],
    },
    bootloader: {
        filename: bootloaderName,
        sha256: sha256(artifactBootloader),
        ...bootloaderContract,
    },
    updater: {
        filename: updaterName,
        sha256: sha256(artifactUpdater),
        ...updaterContract,
    },
};
fs.writeFileSync(path.join(artifactDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
fs.writeFileSync(path.join(artifactDir, "SHA256SUMS"), [
    `${metadata.bootloader.sha256}  ${bootloaderName}`,
    `${metadata.updater.sha256}  ${updaterName}`,
    "",
].join("\n"));

console.log(`Validated CPX ${sourceVersion} bootloader: ${metadata.bootloader.sha256}`);
console.log(`Validated CPX ${sourceVersion} updater: ${metadata.updater.sha256}`);
