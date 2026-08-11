#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const workspace = path.resolve(__dirname, "..");
const pxtDir = path.join(workspace, "pxt-circuit-playground");
const runtimeDir = path.join(workspace, "codal-circuit-playground-bluefruit");
const projectDir = path.join(pxtDir, "built", "cpb-native-project");
const shellDir = path.join(projectDir, "built", "dockercodal");
const outputDir = path.join(workspace, "artifacts", "pxt-cpb");
const targetHexCacheDir = path.join(pxtDir, "built", "hexcache");
const targetBundle = path.join(pxtDir, "built", "target.json");
const targetBundleBackup = path.join(pxtDir, "built", ".target.json.cpb-native-backup");
const codalRepository = "https://github.com/lancaster-university/codal.git";
const codalTag = "v0.9.0";
const binaryName = "CIRCUIT_PLAYGROUND_BLUEFRUIT";
const familyId = 0xada52840;
const applicationStart = 0x26000;
const applicationEnd = 0xea000;

function fail(message) {
    throw new Error(message);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: workspace,
        encoding: "utf8",
        stdio: "inherit",
        ...options
    });
    if (result.error) fail(`${command} could not run: ${result.error.message}`);
    if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

function capture(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: workspace,
        encoding: "utf8",
        ...options
    });
    if (result.error) fail(`${command} could not run: ${result.error.message}`);
    if (result.status !== 0) {
        fail(`${command} exited with status ${result.status}:\n${result.stdout || ""}${result.stderr || ""}`);
    }
    return result.stdout;
}

function sha256(filename) {
    return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function validateUf2(filename) {
    const data = fs.readFileSync(filename);
    if (!data.length || data.length % 512 !== 0) fail(`${filename}: invalid UF2 length`);
    let minimum = Infinity;
    let maximum = -1;
    for (let offset = 0; offset < data.length; offset += 512) {
        const block = data.subarray(offset, offset + 512);
        if (block.readUInt32LE(0) !== 0x0a324655 ||
            block.readUInt32LE(4) !== 0x9e5d5157 ||
            block.readUInt32LE(508) !== 0x0ab16f30) {
            fail(`${filename}: bad UF2 magic in block ${offset / 512}`);
        }
        if (block.readUInt32LE(28) !== familyId) {
            fail(`${filename}: UF2 block ${offset / 512} has the wrong family`);
        }
        const address = block.readUInt32LE(12);
        const length = block.readUInt32LE(16);
        if (!length || length > 476 || address < applicationStart ||
            address + length > applicationEnd || address + length < address) {
            fail(`${filename}: UF2 block ${offset / 512} is outside the CPB application region`);
        }
        minimum = Math.min(minimum, address);
        maximum = Math.max(maximum, address + length);
    }
    if (minimum !== applicationStart) {
        fail(`${filename}: starts at 0x${minimum.toString(16)}, expected 0x${applicationStart.toString(16)}`);
    }
    return { blocks: data.length / 512, minimum, maximum };
}

run("node", [path.join(__dirname, "check-codal-board.js")]);
run("node", [path.join(__dirname, "check-codal-memory.js")]);

fs.rmSync(projectDir, { recursive: true, force: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, "pxt.json"), `${JSON.stringify({
    name: "cpb-native-smoke-test",
    dependencies: {
        "adafruit-circuit-playground-bluefruit": "file:../../libs/adafruit-circuit-playground-bluefruit"
    },
    files: ["main.ts"]
}, null, 4)}\n`);
fs.writeFileSync(path.join(projectDir, "main.ts"), [
    "input.buttonA.onEvent(ButtonEvent.Click, function () {",
    "    light.showRing(\"red orange yellow green blue indigo violet purple white black\")",
    "})",
    "music.playTone(440, 100)",
    "console.logValue(\"temperature\", input.temperature(TemperatureUnit.Celsius))",
    ""
].join("\n"));

run("git", ["clone", "--filter=blob:none", codalRepository, shellDir]);
run("git", ["-C", shellDir, "checkout", "--detach", codalTag]);
const librariesDir = path.join(shellDir, "libraries");
fs.mkdirSync(librariesDir, { recursive: true });
fs.cpSync(runtimeDir, path.join(librariesDir, "codal-circuit-playground-bluefruit"), {
    recursive: true,
    filter: source => {
        const relative = path.relative(runtimeDir, source);
        return relative !== ".git" && !relative.startsWith(`.git${path.sep}`) &&
            relative !== "build" && !relative.startsWith(`build${path.sep}`);
    }
});

if (fs.existsSync(targetBundleBackup)) fail(`stale target bundle backup ${targetBundleBackup}`);
let targetBundleMoved = false;
function restoreTargetBundle() {
    if (targetBundleMoved) {
        fs.renameSync(targetBundleBackup, targetBundle);
        targetBundleMoved = false;
    }
}
if (fs.existsSync(targetBundle)) {
    fs.renameSync(targetBundle, targetBundleBackup);
    targetBundleMoved = true;
    process.on("exit", restoreTargetBundle);
}
try {
    run("node", [
        path.join(pxtDir, "node_modules", "pxt-core", "built", "pxt.js"),
        "build", "--local", "--force"
    ], {
        cwd: projectDir,
        env: {
            ...process.env,
            PXT_FORCE_LOCAL: "1",
            PXT_RUNTIME_DEV: "1"
        }
    });
} finally {
    restoreTargetBundle();
    process.removeListener("exit", restoreTargetBundle);
}

const finalUf2 = path.join(projectDir, "built", "binary.uf2");
const runtimeHex = path.join(shellDir, "build", `${binaryName}.hex`);
const runtimeElf = path.join(shellDir, "build", binaryName);
for (const filename of [finalUf2, runtimeHex, runtimeElf]) {
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        fail(`missing native build artifact ${filename}`);
    }
}

run("node", [
    path.join(pxtDir, "scripts", "check-firmware-bounds.js"),
    path.dirname(runtimeHex),
    "CPB"
]);
const uf2 = validateUf2(finalUf2);

const symbols = capture("arm-none-eabi-nm", ["-C", "-n", runtimeElf]);
for (const [symbol, address] of [
    ["__application_start", applicationStart],
    ["__application_end", applicationEnd]
]) {
    const match = new RegExp(`^([0-9a-f]+)\\s+\\w\\s+${symbol}$`, "im").exec(symbols);
    if (!match || Number.parseInt(match[1], 16) !== address) {
        fail(`${symbol} is missing or does not equal 0x${address.toString(16)}`);
    }
}
for (const expression of [
    /\bHF2::getInterfaceInfo\(\)/,
    /\bpxt::hf2$/m,
    /\bCodalUSB::start\(\)/
]) {
    if (!expression.test(symbols)) fail(`linked CPB application is missing ${expression}`);
}
const generatedPlatform = fs.readFileSync(path.join(shellDir, "pxtapp", "platform.h"), "utf8");
if (!/#define\s+USB_HANDOVER\s+0\b/.test(generatedPlatform)) {
    fail("linked CPB application did not receive the reset-only HF2 handoff override");
}

const buildCache = JSON.parse(fs.readFileSync(path.join(shellDir, "buildcache.json"), "utf8"));
if (!/^[0-9a-f]{64}$/i.test(buildCache.sha)) fail("PXT native build did not emit a cache key");
fs.mkdirSync(targetHexCacheDir, { recursive: true });
const targetHexCache = path.join(targetHexCacheDir, `${buildCache.sha}.hex`);
fs.copyFileSync(runtimeHex, targetHexCache);

fs.mkdirSync(outputDir, { recursive: true });
const artifacts = [
    [finalUf2, "cpb-smoke.uf2"],
    [runtimeHex, "cpb-smoke-runtime.hex"],
    [runtimeElf, "cpb-smoke.elf"]
];
for (const [source, name] of artifacts) {
    fs.copyFileSync(source, path.join(outputDir, name));
}
const checksums = artifacts
    .map(([, name]) => `${sha256(path.join(outputDir, name))}  ${name}`)
    .join("\n") + "\n";
fs.writeFileSync(path.join(outputDir, "SHA256SUMS"), checksums);
fs.writeFileSync(path.join(outputDir, "BUILD-METADATA.json"), `${JSON.stringify({
    codalRepository,
    codalTag,
    codalCommit: capture("git", ["-C", shellDir, "rev-parse", "HEAD"]).trim(),
    runtimeCommit: capture("git", ["-C", runtimeDir, "rev-parse", "HEAD"]).trim(),
    runtimeDirty: capture("git", ["-C", runtimeDir, "status", "--porcelain"]).trim().length > 0,
    pxtCommit: capture("git", ["-C", pxtDir, "rev-parse", "HEAD"]).trim(),
    pxtDirty: capture("git", ["-C", pxtDir, "status", "--porcelain"]).trim().length > 0,
    applicationStart: "0x26000",
    applicationEnd: "0xEA000",
    uf2Family: "0xADA52840",
    pxtHexCacheKey: buildCache.sha,
    uf2Blocks: uf2.blocks,
    uf2End: `0x${uf2.maximum.toString(16)}`
}, null, 4)}\n`);

console.log(`CPB PXT native artifacts written to ${outputDir}`);
console.log(`CPB PXT runtime cache written to ${targetHexCache}`);
process.stdout.write(checksums);
