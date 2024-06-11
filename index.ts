import artifact from "@actions/artifact";
import type { Artifact } from "@actions/artifact";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as util from "util";
import * as cp from "child_process";
import * as tar from "tar";

const esyPrefix = core.getInput("esy-prefix");
const cacheKey = core.getInput("cache-key");
const sourceCacheKey = core.getInput("source-cache-key");
const manifestKey = core.getInput("manifest");
const prepareNPMArtifactsMode = core.getInput("prepare-npm-artifacts-mode");
const bundleNPMArtifactsMode = core.getInput("bundle-npm-artifacts-mode");
const customPostInstallJS = core.getInput("postinstall-js");

async function run(name: string, command: string, args: string[]) {
  const PATH = process.env.PATH ? process.env.PATH : "";
  core.startGroup(name);
  await exec(command, args, { env: { ...process.env, PATH } });
  core.endGroup();
}

function runEsyCommand(name: string, args: string[]) {
  return run(name, "esy", manifestKey ? [`@${manifestKey}`, ...args] : args);
}

const platform = os.platform();
const arch = os.arch();
async function main() {
  try {
    const workingDirectory =
      core.getInput("working-directory") || process.cwd();
    fs.statSync(workingDirectory);
    process.chdir(workingDirectory);

    const installPath = ["~/.esy/source"];
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

    const ESY_FOLDER = esyPrefix ? esyPrefix : path.join(os.homedir(), ".esy");
    const esy3 = fs
      .readdirSync(ESY_FOLDER)
      .filter((name: string) => name.length > 0 && name[0] === "3")
      .sort()
      .pop();

    const depsPath = [path.join(ESY_FOLDER, esy3!, "i")];
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
    if (!manifestKey && !buildCacheKey) {
      await run("Run esy cleanup", "esy", ["cleanup", "."]);
    }
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
    customPostInstallJS ?? path.join(__dirname, "release-postinstall.js");
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
