import { DefaultArtifactClient } from "@actions/artifact";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as util from "util";

const esyPrefix = core.getInput("esy-prefix");
const ESY_FOLDER = esyPrefix ? esyPrefix : path.join(os.homedir(), ".esy");
const cacheKey = core.getInput("cache-key");
const sourceCacheKey = core.getInput("source-cache-key");
const manifestKey = core.getInput("manifest");

async function run(name: string, command: string, args: string[]) {
  const PATH = process.env.PATH ? process.env.PATH : "";
  core.startGroup(name);
  await exec(command, args, { env: { ...process.env, PATH } });
  core.endGroup();
}
function runEsyCommand(name: string, args: string[]) {
  return run(name, "esy", manifestKey ? [`@${manifestKey}`, ...args] : args);
}

async function main() {
  try {
    const workingDirectory =
      core.getInput("working-directory") || process.cwd();
    fs.statSync(workingDirectory);
    process.chdir(workingDirectory);

    const platform = os.platform();
    const arch = os.arch();
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
    const artifact = new DefaultArtifactClient();
    const { id, size } = await artifact.uploadArtifact(
      "dot-esy",
      fs
        .readdirSync(ESY_FOLDER, { recursive: true, withFileTypes: true })
        .filter((dirent) => dirent.isFile())
        .map((dirent) => path.join(dirent.path, dirent.name)),
      ESY_FOLDER,
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
  }
}

main();
