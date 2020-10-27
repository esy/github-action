import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const esyPrefix = core.getInput("esy-prefix");
const cacheKey = core.getInput("cache-key");
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
    const installPath = ["~/.esy/source"];
    const installKey = `source-${platform}-${cacheKey}`;
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
    const buildKey = `build-${platform}-${cacheKey}`;
    const restoreKeys = [`build-${platform}-`, `build-`];

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

    if (!buildCacheKey) {
      await run("Run esy cleanup", "esy", ["cleanup", "."]);
    }
  } catch (e) {
    core.setFailed(e.message);
  }
}

main();
