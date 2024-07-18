import artifact from "@actions/artifact";
import type { Artifact } from "@actions/artifact";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as toolCache from "@actions/tool-cache";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as util from "util";
import * as cp from "child_process";
import * as tar from "tar";
import validateNPMPackageName from "validate-npm-package-name";

function appendEnvironmentFile(key: string, value: string) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT!, `${key}=${value}\n`);
  fs.appendFileSync(process.env.GITHUB_ENV!, `${key}=${value}\n`);
}

let esyPrefix = core.getInput("esy-prefix");
esyPrefix =
  esyPrefix && esyPrefix !== ""
    ? esyPrefix
    : path.join(path.resolve(".."), ".esy");
console.log("esy-prefix", esyPrefix);
const ghOutputEsyPrefixK = "ESY_PREFIX";
console.log(`Setting ${ghOutputEsyPrefixK} to`, esyPrefix);
appendEnvironmentFile(ghOutputEsyPrefixK, esyPrefix);

const cacheKey = core.getInput("cache-key");
const sourceCacheKey = core.getInput("source-cache-key");
const manifestKey = core.getInput("manifest");
const prepareNPMArtifactsMode = core.getInput("prepare-npm-artifacts-mode");
const bundleNPMArtifactsMode = core.getInput("bundle-npm-artifacts-mode");
const customPostInstallJS = core.getInput("postinstall-js");
const setupEsy = core.getInput("setup-esy") || true; // Default behaviour is to install esy for user and cache it
const setupEsyTarball = core.getInput("setup-esy-tarball");
const setupEsyShaSum = core.getInput("setup-esy-shasum");
const setupEsyVersion = core.getInput("setup-esy-version");
const setupEsyNPMPackageName = core.getInput("setup-esy-npm-package");
const partsSeparatedBtAT = setupEsyNPMPackageName.split("@");
if (partsSeparatedBtAT.length > 1 && partsSeparatedBtAT[0] !== "") {
  // ie @ appears in such a way that it separates name and version. Not to signify namespace
  // esy@latest enters this block. @prometheansacrifice/esy doesn't
  console.error(
    "Please specify the version (or NPM dist-tag) in the setup-esy-version field"
  );
  process.exit(-1);
}

async function run(name: string, command: string, args: string[]) {
  const PATH = process.env.PATH ? process.env.PATH : "";
  core.startGroup(name);
  await exec(command, args, { env: { ...process.env, PATH } });
  core.endGroup();
}

type NpmInfo = {
  name: string;
  dist: { tarball: string; shasum: string };
  version: string;
};
let cachedEsyNPMInfo: NpmInfo | undefined;
function getLatestEsyNPMInfo(
  alternativeEsyNPMPackage: string | undefined
): NpmInfo {
  let esyPackage;
  if (!alternativeEsyNPMPackage || alternativeEsyNPMPackage === "") {
    // No alternative was provided. So, fallback to default
    esyPackage = "esy@latest";
  } else {
    const {
      validForOldPackages,
      validForNewPackages,
      errors = [],
    } = validateNPMPackageName(alternativeEsyNPMPackage);
    if (!validForNewPackages || !validForOldPackages) {
      throw new Error(`Invalid alternative NPM package name provided: ${alternativeEsyNPMPackage}
Errors:
${errors.join("\n")}`);
    }
    esyPackage = `${alternativeEsyNPMPackage}@${setupEsyVersion}`;
  }
  try {
    if (!cachedEsyNPMInfo) {
      cachedEsyNPMInfo = JSON.parse(
        cp.execSync(`npm info "${esyPackage}" --json`).toString().trim()
      );
      return cachedEsyNPMInfo!;
    } else {
      return cachedEsyNPMInfo;
    }
  } catch (e: any) {
    throw new Error("Could not download the setup esy. Reason: " + e.message);
  }
}

function getEsyDownloadArtifactsMeta(
  alternativeEsyNPMPackage: string | undefined
) {
  const esyNPMInfo = getLatestEsyNPMInfo(alternativeEsyNPMPackage);
  const tarballUrl = esyNPMInfo.dist.tarball;
  const shasum = esyNPMInfo.dist.shasum;
  const version = esyNPMInfo.version;
  const name = esyNPMInfo.name;
  return { name, tarballUrl, shasum, version };
}

function runEsyCommand(name: string, args: string[]) {
  args.push(`--prefix-path=${esyPrefix}`);
  return run(name, "esy", manifestKey ? [`@${manifestKey}`, ...args] : args);
}

function computeChecksum(filePath: string, algo: string) {
  return new Promise((resolve) => {
    let stream = fs.createReadStream(filePath).pipe(crypto.createHash(algo));
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("hex");
    });
    stream.on("end", () => {
      resolve(buf);
    });
  });
}

const platform = os.platform();
const arch = os.arch();
async function main() {
  const workingDirectory = core.getInput("working-directory") || process.cwd();
  try {
    if (setupEsy) {
      let tarballUrl, checksum, esyPackageVersion, esyPackageName;
      if (!setupEsyVersion || !setupEsyShaSum || !setupEsyTarball) {
        const meta = getEsyDownloadArtifactsMeta(setupEsyNPMPackageName);
        tarballUrl = meta.tarballUrl;
        checksum = meta.shasum;
        esyPackageVersion = meta.version;
        esyPackageName = meta.name;
      } else {
        tarballUrl = setupEsyTarball;
        esyPackageVersion = setupEsyVersion;
        checksum = setupEsyShaSum;
        esyPackageName = setupEsyNPMPackageName;
      }
      let cachedPath = toolCache.find(esyPackageName, esyPackageVersion, arch);
      if (cachedPath === "") {
        console.log("Fetching tarball from", tarballUrl);
        const downloadedEsyNPMTarball = await toolCache.downloadTool(
          tarballUrl
        );
        const checksumAlgo = "sha1";
        const computedChecksum = await computeChecksum(
          downloadedEsyNPMTarball,
          checksumAlgo
        );
        if (computedChecksum !== checksum) {
          throw new Error(
            `Downloaded by checksum failed. url: ${setupEsyTarball} downloadPath: ${downloadedEsyNPMTarball} checksum expected: ${checksum} checksum computed: ${computedChecksum} checksum algorithm: ${checksumAlgo}`
          );
        } else {
          console.log(
            "Checksum validation succeeded. Downloaded tarball's checksum is:",
            checksum
          );
        }

        const extractedEsyNPM = await toolCache.extractTar(
          downloadedEsyNPMTarball
        );
        core.startGroup("Running postinstall");
        const esyPackagePath = path.join(extractedEsyNPM, "package");
        const postInstall = JSON.parse(
          fs
            .readFileSync(path.join(esyPackagePath, "package.json"))
            .toString()
            .trim()
        ).scripts.postinstall;
        process.chdir(esyPackagePath);
        await exec(postInstall);
        core.endGroup();
        process.chdir(workingDirectory);
        cachedPath = await toolCache.cacheDir(
          esyPackagePath,
          esyPackageName,
          esyPackageVersion,
          arch
        );
      }
      core.addPath(path.join(cachedPath, "bin"));
    }
    fs.statSync(workingDirectory);
    process.chdir(workingDirectory);
    const installPath = [`${esyPrefix}/source`];
    const installKey = `source-${platform}-${arch}-${sourceCacheKey}`;
    core.startGroup("Restoring install cache");
    const installCacheKey = await cache.restoreCache(
      installPath,
      installKey,
      []
    );
    if (installCacheKey) {
      console.log("Restored the install cache");
    }
    core.endGroup();

    await runEsyCommand("Run esy install", ["install"]);

    if (installCacheKey != installKey) {
      await cache.saveCache(installPath, installKey);
    }

    const esy3 = fs
      .readdirSync(esyPrefix)
      .filter((name: string) => name.length > 0 && name[0] === "3")
      .sort()
      .pop();

    const depsPath = [path.join(esyPrefix, esy3!, "i")];
    const buildKey = `build-${platform}-${arch}-${cacheKey}`;
    const restoreKeys = [`build-${platform}-${arch}-`, `build-`];

    core.startGroup("Restoring build cache");
    const buildCacheKey = await cache.restoreCache(
      depsPath,
      buildKey,
      restoreKeys
    );
    if (buildCacheKey) {
      console.log("Restored the build cache");
    }
    core.endGroup();

    if (!buildCacheKey) {
      await runEsyCommand("Run esy build-dependencies", ["build-dependencies"]);
    }

    await runEsyCommand("Run esy build", ["build"]);

    if (buildCacheKey != buildKey) {
      await cache.saveCache(depsPath, buildKey);
    }

    // TODO: support cleanup + manifest
    // Need to improve how subcommands are called
    // --prefix after cleanup subcommand doesn't work
    // --prefix prepended doesn't work with any other sub-command
    // if (!manifestKey && !buildCacheKey) {
    //   await runEsyCommand("Run esy cleanup", ["cleanup", "."]);
    // }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(util.inspect(error));
    }
  }
}

async function uncompress(
  dest: string,
  tarFile: string,
  strip?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.createReadStream(tarFile)
      .pipe(
        tar.x({
          strip: strip,
          C: dest, // alias for cwd:'some-dir', also ok
        })
      )
      .on("close", () => resolve())
      .on("error", reject);
  });
}
async function compress(dir: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    tar
      .c({ z: true }, [dir])
      .pipe(fs.createWriteStream(outputFile))
      .on("close", () => resolve())
      .on("error", reject);
  });
}
async function prepareNPMArtifacts() {
  const statusCmd = manifestKey ? `esy ${manifestKey} status` : "esy status";
  try {
    const manifestFilePath = JSON.parse(
      cp.execSync(statusCmd).toString()
    ).rootPackageConfigPath;
    const manifest = JSON.parse(fs.readFileSync(manifestFilePath).toString());
    if (manifest.esy.release) {
      await runEsyCommand("Running esy npm-release", ["npm-release"]);
    }
    let tarFile = `npm-tarball.tgz`;
    await compress("_release", tarFile);

    const artifactName = `esy-npm-release-${platform}-${arch}`;
    console.log("Artifact name: ", artifactName);
    const { id, size } = await artifact.uploadArtifact(
      artifactName,
      [tarFile],
      process.env.GITHUB_WORKSPACE!,
      {
        // The level of compression for Zlib to be applied to the artifact archive.
        // - 0: No compression
        // - 1: Best speed
        // - 6: Default compression (same as GNU Gzip)
        // - 9: Best compression
        compressionLevel: 0,
        // optional: how long to retain the artifact
        // if unspecified, defaults to repository/org retention settings (the limit of this value)
        retentionDays: 10,
      }
    );

    console.log(`Created artifact with id: ${id} (bytes: ${size}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(util.inspect(error));
    }
  }
}

async function bundleNPMArtifacts() {
  const workingDirectory = core.getInput("working-directory") || process.cwd();
  fs.statSync(workingDirectory);
  process.chdir(workingDirectory);
  const releaseFolder = path.join(workingDirectory, "_npm-release");
  fs.mkdirSync(releaseFolder);
  const { artifacts } = await artifact.listArtifacts();

  // TODO: filter out artifacts that dont have esy-npm-release-* prefix in their name
  const artifactFoldersList = await Promise.all(
    artifacts.map(async (a: Artifact) => {
      const folderName = `platform-${a.name}`;
      const folderPath = path.join(releaseFolder, folderName);
      await artifact.downloadArtifact(a.id, {
        path: folderPath,
      });
      await uncompress(folderPath, path.join(folderPath, "npm-tarball.tgz"), 1);
      return folderName;
    })
  );
  const artifactFolders = artifactFoldersList.reduce(
    (acc: string[], folderName: string) => {
      acc.push(folderName);
      return acc;
    },
    []
  );
  const esyInstallReleaseJS = "esyInstallRelease.js";
  fs.cpSync(
    path.join(releaseFolder, artifactFoldersList[0], esyInstallReleaseJS),
    path.join(releaseFolder, esyInstallReleaseJS)
  );
  console.log("Creating package.json");
  const possibleEsyJsonPath = path.join(workingDirectory, "esy.json");
  const possiblePackageJsonPath = path.join(workingDirectory, "package.json");
  const mainPackageJsonPath = fs.existsSync(possibleEsyJsonPath)
    ? possibleEsyJsonPath
    : possiblePackageJsonPath;
  const exists = fs.existsSync(mainPackageJsonPath);
  if (!exists) {
    console.error("No package.json or esy.json at " + mainPackageJsonPath);
    process.exit(1);
  }
  const mainPackageJson = JSON.parse(
    fs.readFileSync(`${mainPackageJsonPath}`).toString()
  );
  const bins = Array.isArray(mainPackageJson.esy.release.bin)
    ? mainPackageJson.esy.release.bin.reduce(
        (acc: any, curr: string) =>
          Object.assign({ [curr]: "bin/" + curr }, acc),
        {}
      )
    : Object.keys(mainPackageJson.esy.release.bin).reduce(
        (acc, currKey) =>
          Object.assign(
            { [currKey]: "bin/" + mainPackageJson.esy.release.bin[currKey] },
            acc
          ),
        {}
      );
  const rewritePrefix =
    mainPackageJson.esy &&
    mainPackageJson.esy.release &&
    mainPackageJson.esy.release.rewritePrefix;

  function exec(cmd: string) {
    console.log(`exec: ${cmd}`);
    return cp.execSync(cmd).toString().trim();
  }
  const version = exec("git describe --tags --always");
  const packageJson = JSON.stringify(
    {
      name: mainPackageJson.name,
      version,
      license: mainPackageJson.license,
      description: mainPackageJson.description,
      repository: mainPackageJson.repository,
      scripts: {
        postinstall: rewritePrefix
          ? "node -e \"process.env['OCAML_VERSION'] = process.platform == 'linux' ? '4.12.0-musl.static.flambda': '4.12.0'; process.env['OCAML_PKG_NAME'] = 'ocaml'; process.env['ESY_RELEASE_REWRITE_PREFIX']=true; require('./postinstall.js')\""
          : "node -e \"process.env['OCAML_VERSION'] = process.platform == 'linux' ? '4.12.0-musl.static.flambda': '4.12.0'; process.env['OCAML_PKG_NAME'] = 'ocaml'; require('./postinstall.js')\"",
      },
      bin: bins,
      files: [
        "_export/",
        "bin/",
        "postinstall.js",
        "esyInstallRelease.js",
      ].concat(artifactFolders),
    },
    null,
    2
  );

  fs.writeFileSync(path.join(releaseFolder, "package.json"), packageJson, {
    encoding: "utf8",
  });

  try {
    console.log("Copying LICENSE");
    fs.copyFileSync(
      path.join(workingDirectory, "LICENSE"),
      path.join(releaseFolder, "LICENSE")
    );
  } catch (e) {
    console.warn("No LICENSE found");
  }

  try {
    console.log("Copying README.md");
    fs.copyFileSync(
      path.join(workingDirectory, "README.md"),
      path.join(releaseFolder, "README.md")
    );
  } catch {
    console.warn("No LICENSE found");
  }

  const releasePostInstallJS =
    typeof customPostInstallJS === "string" && customPostInstallJS !== ""
      ? customPostInstallJS
      : path.join(__dirname, "release-postinstall.js");
  console.log("Copying postinstall.js from", releasePostInstallJS);
  fs.copyFileSync(
    releasePostInstallJS,
    path.join(releaseFolder, "postinstall.js")
  );

  console.log("Creating placeholder files");
  const placeholderFile = `:; echo "You need to have postinstall enabled"; exit $?
@ECHO OFF
ECHO You need to have postinstall enabled`;
  fs.mkdirSync(path.join(releaseFolder, "bin"));

  Object.keys(bins).forEach((name) => {
    if (bins[name]) {
      const binPath = path.join(releaseFolder, bins[name]);
      fs.writeFileSync(binPath, placeholderFile);
      fs.chmodSync(binPath, 0o777);
    } else {
      console.log("bins[name] name=" + name + " was empty. Weird.");
      console.log(bins);
    }
  });

  let tarFile = `npm-release.tgz`;
  await compress(path.relative(workingDirectory, releaseFolder), tarFile);

  await artifact.uploadArtifact(
    "npm-release",
    [tarFile],
    process.env.GITHUB_WORKSPACE!,
    {
      // The level of compression for Zlib to be applied to the artifact archive.
      // - 0: No compression
      // - 1: Best speed
      // - 6: Default compression (same as GNU Gzip)
      // - 9: Best compression
      compressionLevel: 0,
      // optional: how long to retain the artifact
      // if unspecified, defaults to repository/org retention settings (the limit of this value)
      retentionDays: 10,
    }
  );

  core.endGroup();
}

if (prepareNPMArtifactsMode) {
  prepareNPMArtifacts();
} else if (bundleNPMArtifactsMode) {
  bundleNPMArtifacts();
} else {
  main();
}
