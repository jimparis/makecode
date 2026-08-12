#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const workspace = path.resolve(__dirname, "..");
const pxtDir = path.join(workspace, "pxt-circuit-playground");
const pxtCoreDir = path.join(workspace, "pxt");
const bootloaderDir = path.join(workspace, "Adafruit_nRF52_Bootloader");
const bootloaderArtifactDir = path.join(workspace, "artifacts", "bootloader");
const cpbUpdaterName = "update-circuitplayground_nrf52840_bootloader-makecode-hf2-nosd.uf2";
const cpbUpdaterSource = path.join(bootloaderArtifactDir, cpbUpdaterName);
const generatedSite = path.join(pxtDir, "built", "static-release");
const outputDir = path.join(workspace, "artifacts", ".static-staging");
const finalOutputDir = path.join(workspace, "artifacts", "static");
const siteDir = path.join(outputDir, "site");
const contextDir = path.join(outputDir, "image-context");
const nodeImage = "docker.io/library/node@sha256:673fce836d5a9185da33352682bfedb17c174d016370d08616748dff76fda862";
const goImage = "docker.io/library/golang@sha256:aee43c3ccbf24fdffb7295693b6e33b21e01baec1b2a55acc351fde345e9ec34";

function fail(message) {
    throw new Error(message);
}

function result(command, args, options = {}) {
    const value = spawnSync(command, args, {
        cwd: workspace,
        encoding: "utf8",
        ...options
    });
    if (value.error) fail(`${command} could not run: ${value.error.message}`);
    return value;
}

function run(command, args, options = {}) {
    const value = result(command, args, { stdio: "inherit", ...options });
    if (value.status !== 0) fail(`${command} exited with status ${value.status}`);
}

function capture(command, args, options = {}) {
    const value = result(command, args, options);
    if (value.status !== 0) {
        fail(`${command} exited with status ${value.status}:\n${value.stdout || ""}${value.stderr || ""}`);
    }
    return value.stdout.trim();
}

function sha256(filename) {
    return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function checksumManifest(filename) {
    const result = new Map();
    for (const line of fs.readFileSync(filename, "utf8").trim().split("\n")) {
        const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
        if (!match || result.has(match[2])) fail(`invalid checksum manifest line: ${line}`);
        result.set(match[2], match[1]);
    }
    return result;
}

function filesBelow(directory, relative = "") {
    const entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) files.push(...filesBelow(directory, name));
        else if (entry.isFile()) files.push(name);
        else fail(`${path.join(directory, name)} is not a regular file`);
    }
    return files;
}

function gitTreeDigest(directory) {
    const names = capture("git", [
        "-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "-z"
    ]).split("\0").filter(Boolean).sort();
    const hash = crypto.createHash("sha256");
    for (const name of names) {
        const filename = path.join(directory, name);
        hash.update(name).update("\0");
        if (fs.existsSync(filename) && fs.statSync(filename).isFile()) {
            hash.update(fs.readFileSync(filename));
        } else {
            hash.update("<missing>");
        }
        hash.update("\0");
    }
    return hash.digest("hex");
}

const previousManifestPath = path.join(finalOutputDir, "SITE-SHA256SUMS");
const previousMetadataPath = path.join(finalOutputDir, "BUILD-METADATA.json");
const previousMetadata = fs.existsSync(previousMetadataPath)
    ? JSON.parse(fs.readFileSync(previousMetadataPath, "utf8"))
    : {};
const previousManifest = fs.existsSync(previousManifestPath)
    ? fs.readFileSync(previousManifestPath, "utf8")
    : "";
const previousCss = new Map();
if (previousManifest) {
    for (const name of ["semantic.css", "rtlsemantic.css"]) {
        const filename = path.join(finalOutputDir, "site", name);
        if (fs.existsSync(filename)) previousCss.set(name, fs.readFileSync(filename, "utf8"));
    }
}
const pxtCommit = capture("git", ["-C", pxtDir, "rev-parse", "HEAD"]);
const pxtCoreCommit = capture("git", ["-C", pxtCoreDir, "rev-parse", "HEAD"]);
const bootloaderCommit = capture("git", ["-C", bootloaderDir, "rev-parse", "HEAD"]);
const sourceDateEpoch = capture("git", ["-C", pxtDir, "show", "-s", "--format=%ct", "HEAD"]);
const pxtSourceDigest = gitTreeDigest(pxtDir);
const pxtCoreSourceDigest = gitTreeDigest(pxtCoreDir);
const bootloaderSourceDigest = gitTreeDigest(bootloaderDir);
const bootloaderMetadataPath = path.join(bootloaderArtifactDir, "BUILD-METADATA.json");
const bootloaderChecksumsPath = path.join(bootloaderArtifactDir, "SHA256SUMS");
for (const filename of [cpbUpdaterSource, bootloaderMetadataPath, bootloaderChecksumsPath]) {
    if (!fs.existsSync(filename)) fail(`missing bootloader build artifact: ${filename}`);
}
const bootloaderMetadata = JSON.parse(fs.readFileSync(bootloaderMetadataPath, "utf8"));
const bootloaderChecksums = checksumManifest(bootloaderChecksumsPath);
const cpbUpdaterSha256 = sha256(cpbUpdaterSource);
if (bootloaderMetadata.sourceCommit !== bootloaderCommit || bootloaderMetadata.sourceDirty ||
    bootloaderMetadata.updateUf2Family !== "0xd663823c" ||
    bootloaderMetadata.updateUf2BoardId !== "0x239a0045" ||
    bootloaderMetadata.updateUf2MinimumExistingBootloader !== "0.4.0" ||
    bootloaderMetadata.updateUf2PreservesSoftDevice !== true ||
    bootloaderMetadata.updateUf2MayOverwriteApplication !== true ||
    bootloaderMetadata.updateUf2Bytes !== fs.statSync(cpbUpdaterSource).size ||
    bootloaderChecksums.get(cpbUpdaterName) !== cpbUpdaterSha256) {
    fail("CPB bootloader updater does not match its pinned, validated build metadata");
}
const releaseBuilderDigest = crypto.createHash("sha256")
    .update(fs.readFileSync(__filename))
    .update(fs.readFileSync(path.join(workspace, "scripts", "build-bootloader.js")))
    .update(fs.readFileSync(path.join(workspace, "deployment", "Containerfile")))
    .update(fs.readFileSync(path.join(workspace, "deployment", "circuit-playground-makecode.container.in")))
    .update(fs.readFileSync(path.join(workspace, "deployment", "server", "go.mod")))
    .update(fs.readFileSync(path.join(workspace, "deployment", "server", "main.go")))
    .digest("hex");
const serviceWorkerReleaseId = crypto.createHash("sha256")
    .update(pxtSourceDigest)
    .update(pxtCoreSourceDigest)
    .update(bootloaderSourceDigest)
    .update(cpbUpdaterSha256)
    .update(releaseBuilderDigest)
    .digest("hex");
fs.rmSync(generatedSite, { recursive: true, force: true });
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

run("podman", [
    "run", "--rm",
    "-e", `PXT_STATIC_RELEASE_ID=${serviceWorkerReleaseId}`,
    "-v", `${workspace}:/workspace:Z`,
    "-w", "/workspace/pxt-circuit-playground",
    nodeImage,
    "node", "scripts/pxt-static-check.js", "built/static-release"
]);

fs.cpSync(generatedSite, siteDir, { recursive: true });
const firmwareDir = path.join(siteDir, "docs", "static", "firmware");
fs.mkdirSync(firmwareDir, { recursive: true });
fs.copyFileSync(cpbUpdaterSource, path.join(firmwareDir, cpbUpdaterName));
const releaseManifest = path.join(siteDir, "release.manifest");
const releaseContents = fs.readFileSync(releaseManifest, "utf8")
    .replace(/^# ver .*$/m, `# ver SOURCE_DATE_EPOCH ${sourceDateEpoch}`);
fs.writeFileSync(releaseManifest, releaseContents);
const siteFiles = filesBelow(siteDir).sort();
const manifest = siteFiles.map(name => `${sha256(path.join(siteDir, name))}  ${name}`).join("\n") + "\n";
fs.writeFileSync(path.join(outputDir, "SITE-SHA256SUMS"), manifest);
const siteDigest = crypto.createHash("sha256").update(manifest).digest("hex");
const releaseDigest = crypto.createHash("sha256")
    .update(siteDigest)
    .update(releaseBuilderDigest)
    .digest("hex");
const targetVersion = JSON.parse(fs.readFileSync(path.join(pxtDir, "package.json"), "utf8")).version;
const releaseVersion = process.env.RELEASE_VERSION ||
    `v${targetVersion}-alpha.${releaseDigest.slice(0, 12)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(releaseVersion)) {
    fail(`invalid release version: ${releaseVersion}`);
}
const sameReleaseInputs = previousMetadata.reproducibleManifestVersion === 3 &&
    previousMetadata.pxtSourceDigest === pxtSourceDigest &&
    previousMetadata.pxtCoreSourceDigest === pxtCoreSourceDigest &&
    previousMetadata.bootloaderSourceDigest === bootloaderSourceDigest &&
    previousMetadata.cpbUpdaterSha256 === cpbUpdaterSha256 &&
    previousMetadata.releaseBuilderDigest === releaseBuilderDigest;
if (sameReleaseInputs && previousManifest && previousManifest !== manifest) {
    const parse = value => new Map(value.trim().split("\n").filter(Boolean)
        .map(line => [line.slice(66), line.slice(0, 64)]));
    const before = parse(previousManifest);
    const after = parse(manifest);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter(name => before.get(name) !== after.get(name)).sort();
    const details = changed.map(name => {
        const oldValue = previousCss.get(name);
        if (oldValue === undefined) return name;
        const newValue = fs.readFileSync(path.join(siteDir, name), "utf8");
        let offset = 0;
        while (offset < oldValue.length && offset < newValue.length &&
            oldValue.charCodeAt(offset) === newValue.charCodeAt(offset)) offset++;
        return `${name} (old ${oldValue.length} bytes, new ${newValue.length} bytes, first difference ${offset})`;
    });
    fail(`static package is not reproducible; changed files:\n  ${details.join("\n  ")}`);
}

fs.mkdirSync(contextDir, { recursive: true });
fs.cpSync(siteDir, path.join(contextDir, "site"), { recursive: true });
fs.cpSync(path.join(workspace, "deployment", "server"), path.join(contextDir, "server"), {
    recursive: true,
    filter: source => !source.endsWith("main_test.go")
});

const imageTag = `localhost/circuit-playground-makecode:${releaseVersion}`;
run("podman", [
    "build", "--pull=never", "--timestamp", sourceDateEpoch,
    "--build-arg", `SOURCE_REVISION=${pxtCommit}`,
    "--build-arg", `RELEASE_VERSION=${releaseVersion}`,
    "-t", imageTag,
    "-f", path.join(workspace, "deployment", "Containerfile"),
    contextDir
]);
const imageId = capture("podman", ["image", "inspect", imageTag, "--format", "{{.Id}}"]);
const ociDirectory = path.join(outputDir, "image.oci");
const ociArchive = path.join(outputDir, `circuit-playground-makecode-${releaseVersion}.oci.tar`);
run("podman", ["save", "--quiet", "--format", "oci-dir", "-o", ociDirectory, imageTag]);
run("tar", [
    "--sort=name", `--mtime=@${sourceDateEpoch}`, "--owner=0", "--group=0", "--numeric-owner",
    "-cf", ociArchive, "-C", ociDirectory, "."
]);
const ociArchiveSha256 = sha256(ociArchive);
fs.writeFileSync(path.join(outputDir, "OCI-SHA256SUMS"),
    `${ociArchiveSha256}  ${path.basename(ociArchive)}\n`);
if (sameReleaseInputs && previousMetadata.reproducibleOciArchiveVersion === 2 &&
    previousMetadata.imageId === imageId && previousMetadata.ociArchiveSha256 &&
    previousMetadata.ociArchiveSha256 !== ociArchiveSha256) {
    fail("OCI archive changed while the image ID remained identical");
}

const quadletTemplate = fs.readFileSync(path.join(
    workspace, "deployment", "circuit-playground-makecode.container.in"), "utf8");
if (!quadletTemplate.includes("@IMAGE@")) fail("deployment Quadlet has no image placeholder");
fs.writeFileSync(path.join(outputDir, "circuit-playground-makecode.container"),
    quadletTemplate.replace("@IMAGE@", imageTag));
const quadletGenerator = [
    "/usr/libexec/podman/quadlet",
    "/usr/lib/systemd/system-generators/podman-system-generator"
].find(filename => fs.existsSync(filename));
if (!quadletGenerator) fail("Podman Quadlet generator is not installed");
const generatedUnit = capture(quadletGenerator, ["--user", "--dryrun"], {
    env: { ...process.env, QUADLET_UNIT_DIRS: outputDir }
});
if (!/ExecStart=.*--read-only/.test(generatedUnit) ||
    !/ExecStart=.*--user %U:%G/.test(generatedUnit) ||
    !/ExecStart=.*--userns keep-id/.test(generatedUnit) ||
    !/ExecStart=.*(?:--volume|-v) .*makecode-shares/.test(generatedUnit) ||
    !/ExecStart=.*--publish 127\.0\.0\.1:3232:3232/.test(generatedUnit)) {
    fail("rendered Quadlet does not generate the required read-only, persistent, loopback service");
}

let containerId = "";
const shareTestDir = fs.mkdtempSync(path.join(outputDir, "share-test-"));
try {
    containerId = capture("podman", [
        "run", "--rm", "-d", "--read-only", "--tmpfs", "/tmp:size=16m",
        "--userns", "keep-id", "--user", `${process.getuid()}:${process.getgid()}`,
        "-v", `${shareTestDir}:/var/lib/makecode-shares:Z`,
        "-p", "127.0.0.1::3232", imageTag
    ]);
    const port = capture("podman", ["port", containerId, "3232/tcp"]);
    const match = /:(\d+)\s*$/.exec(port);
    if (!match) fail(`could not parse published container port: ${port}`);
    const url = `http://127.0.0.1:${match[1]}/`;
    const headers = capture("curl", [
        "--retry", "10", "--retry-connrefused", "--retry-delay", "0", "-fsSI", url
    ]);
    const body = capture("curl", ["-fsS", url]);
    const boardImageHeaders = capture("curl", [
        "-fsSI", `${url}static/libs/adafruit-circuit-playground-bluefruit.jpg`
    ]);
    const updaterUrl = `${url}static/firmware/${cpbUpdaterName}`;
    const updaterHeaders = capture("curl", ["-fsSI", updaterUrl]);
    const servedUpdater = path.join(outputDir, "served-cpb-updater.uf2");
    run("curl", ["-fsS", "-o", servedUpdater, updaterUrl]);
    const boardsBody = capture("curl", ["-fsS", `${url}boards`]);
    const missingStaticStatus = capture("curl", [
        "-sS", "-o", "/dev/null", "-w", "%{http_code}", `${url}static/does-not-exist.png`
    ]);
    if (!/^permissions-policy:\s*usb=\(self\), hid=\(self\)\s*$/im.test(headers)) {
        fail("static container does not return the WebUSB and WebHID permissions policy");
    }
    if (!/^x-robots-tag:\s*noindex, nofollow\s*$/im.test(headers)) {
        fail("static container does not return the alpha noindex policy");
    }
    if (!/Circuit Playground MakeCode/i.test(body)) fail("static container did not serve the editor shell");
    if (!/^content-type:\s*image\/jpeg\s*$/im.test(boardImageHeaders)) {
        fail("static container did not serve /static board artwork as an image");
    }
    if (!/^content-type:\s*application\/octet-stream\s*$/im.test(updaterHeaders) ||
        !new RegExp(`^content-disposition:\\s*attachment; filename="${cpbUpdaterName}"\\s*$`, "im")
            .test(updaterHeaders) || sha256(servedUpdater) !== cpbUpdaterSha256) {
        fail("static container did not serve the validated CPB updater as an exact download");
    }
    fs.rmSync(servedUpdater);
    if (!/<h1>Boards<\/h1>/.test(boardsBody)) {
        fail("static container did not resolve the clean /boards documentation route");
    }
    if (missingStaticStatus !== "404") {
        fail(`static container returned HTTP ${missingStaticStatus} for a missing /static asset`);
    }

    const publishFixture = path.join(outputDir, "share-publish-fixture.json");
    fs.writeFileSync(publishFixture, JSON.stringify({
        id: "build-validation-project",
        name: "Build validation share",
        target: "circuitplayground",
        targetVersion,
        description: "Build-time publishing validation",
        editor: "blocksprj",
        header: JSON.stringify({
            name: "Build validation share", target: "circuitplayground",
            targetVersion, editor: "blocksprj"
        }),
        text: JSON.stringify({
            "pxt.json": JSON.stringify({
                name: "Build validation share", dependencies: {}
            }),
            "main.ts": "light.setAll(0x123456)"
        }),
        meta: { versions: { target: targetVersion } }
    }));
    const publishResponse = JSON.parse(capture("curl", [
        "-fsS", "-H", "Content-Type: application/json", "--data-binary", `@${publishFixture}`,
        `${url}api/scripts`
    ]));
    if (!/^_[23456789A-HJ-NP-Za-km-z]{12}$/.test(publishResponse.id) ||
        publishResponse.shortid !== publishResponse.id) {
        fail(`publishing API returned an invalid share ID: ${JSON.stringify(publishResponse)}`);
    }
    const publishedMeta = JSON.parse(capture("curl", ["-fsS", `${url}api/${publishResponse.id}`]));
    const publishedText = JSON.parse(capture("curl", ["-fsS", `${url}api/${publishResponse.id}/text`]));
    if (publishedMeta.target !== "circuitplayground" ||
        publishedText["main.ts"] !== "light.setAll(0x123456)") {
        fail("publishing API did not round-trip the validation project");
    }
    fs.rmSync(publishFixture);
} finally {
    if (containerId) result("podman", ["stop", "-t", "1", containerId]);
    fs.rmSync(shareTestDir, { recursive: true, force: true });
}

fs.writeFileSync(path.join(outputDir, "BUILD-METADATA.json"), `${JSON.stringify({
    reproducibleManifestVersion: 3,
    reproducibleOciArchiveVersion: 2,
    pxtCommit,
    pxtCoreCommit,
    bootloaderCommit,
    pxtDirty: capture("git", ["-C", pxtDir, "status", "--porcelain"]).length > 0,
    pxtCoreDirty: capture("git", ["-C", pxtCoreDir, "status", "--porcelain"]).length > 0,
    bootloaderDirty: capture("git", ["-C", bootloaderDir, "status", "--porcelain"]).length > 0,
    pxtSourceDigest,
    pxtCoreSourceDigest,
    bootloaderSourceDigest,
    cpbUpdaterName,
    cpbUpdaterSha256,
    releaseBuilderDigest,
    serviceWorkerReleaseId,
    targetVersion,
    releaseVersion,
    sourceDateEpoch: Number(sourceDateEpoch),
    nodeImage,
    builderImage: goImage,
    baseImage: "scratch",
    siteFiles: siteFiles.length,
    siteDigest,
    releaseDigest,
    imageTag,
    imageId,
    ociArchive: path.basename(ociArchive),
    ociArchiveSha256
}, null, 4)}\n`);

fs.rmSync(ociDirectory, { recursive: true, force: true });
fs.rmSync(contextDir, { recursive: true, force: true });

fs.rmSync(finalOutputDir, { recursive: true, force: true });
fs.renameSync(outputDir, finalOutputDir);

console.log(`Static release site written to ${path.join(finalOutputDir, "site")}`);
console.log(`Static site digest: ${siteDigest}`);
console.log(`Release version: ${releaseVersion}`);
console.log(`Validated local image: ${imageTag} (${imageId})`);
