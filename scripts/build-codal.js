#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const workspace = path.resolve(__dirname, "..");
const runtimeDir = path.join(workspace, "codal-circuit-playground-bluefruit");
const outputDir = path.join(workspace, "artifacts", "codal");
const codalRepository = "https://github.com/lancaster-university/codal.git";
const codalCommit = "e6952acdf1d8e790c439c6ba06cff44c0263356c";
const buildImage = "docker.io/pext/yotta@sha256:54acddef1aac8e4a654e591b617e38da12d784da65e8ddc858e8c28fa8bc24e3";
const binaryName = "CIRCUIT_PLAYGROUND_BLUEFRUIT";

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

run("node", [path.join(__dirname, "check-codal-board.js")]);
run("node", [path.join(__dirname, "check-codal-memory.js")]);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpb-codal-build-"));
const shellDir = path.join(tempDir, "codal");
try {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", codalRepository, shellDir]);
    run("git", ["-C", shellDir, "checkout", "--detach", codalCommit]);

    const librariesDir = path.join(shellDir, "libraries");
    fs.mkdirSync(librariesDir);
    fs.symlinkSync("/runtime", path.join(librariesDir, "codal-circuit-playground-bluefruit"));
    fs.writeFileSync(path.join(shellDir, "codal.json"), `${JSON.stringify({
        target: {
            name: "codal-circuit-playground-bluefruit",
            url: "https://github.com/jimparis/codal-circuit-playground-bluefruit",
            branch: "main",
            type: "git"
        },
        output_folder: "."
    }, null, 4)}\n`);

    run("podman", [
        "run", "--rm",
        "-v", `${shellDir}:/work:Z`,
        "-v", `${runtimeDir}:/runtime:ro,Z`,
        "-w", "/work",
        buildImage,
        "python", "build.py"
    ]);

    run("node", [
        path.join(workspace, "pxt-circuit-playground", "scripts", "check-firmware-bounds.js"),
        shellDir,
        "CPB"
    ]);

    const elf = path.join(shellDir, "build", binaryName);
    const symbols = capture("arm-none-eabi-nm", ["-n", elf]);
    for (const [symbol, address] of [
        ["__application_start", 0x26000],
        ["__application_end", 0xea000]
    ]) {
        const match = new RegExp(`^([0-9a-f]+)\\s+\\w\\s+${symbol}$`, "im").exec(symbols);
        if (!match || Number.parseInt(match[1], 16) !== address) {
            fail(`${symbol} is missing or does not equal 0x${address.toString(16)}`);
        }
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const artifacts = [
        [path.join(shellDir, `${binaryName}.hex`), `${binaryName}.hex`],
        [path.join(shellDir, `${binaryName}.bin`), `${binaryName}.bin`],
        [elf, `${binaryName}.elf`]
    ];
    for (const [source, name] of artifacts) {
        if (!fs.statSync(source).isFile()) fail(`missing CODAL build artifact ${source}`);
        fs.copyFileSync(source, path.join(outputDir, name));
    }

    const checksums = artifacts
        .map(([, name]) => `${sha256(path.join(outputDir, name))}  ${name}`)
        .join("\n") + "\n";
    fs.writeFileSync(path.join(outputDir, "SHA256SUMS"), checksums);
    fs.writeFileSync(path.join(outputDir, "BUILD-METADATA.json"), `${JSON.stringify({
        codalRepository,
        codalCommit,
        buildImage,
        runtimeCommit: capture("git", ["-C", runtimeDir, "rev-parse", "HEAD"]).trim(),
        runtimeDirty: capture("git", ["-C", runtimeDir, "status", "--porcelain"]).trim().length > 0,
        applicationStart: "0x26000",
        applicationEnd: "0xEA000"
    }, null, 4)}\n`);

    console.log(`CPB CODAL artifacts written to ${outputDir}`);
    process.stdout.write(checksums);
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
