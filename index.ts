const fs = require("fs");
const path = require("path");
const cache = require("@actions/cache");
const os = require('os');
const { execSync } = require('child_process');
const core = require('@actions/core');

const esyPrefix = core.getInput('esy-prefix');
const cacheKey = core.getInput('cache-key');

const run = (name: string, command: string) => {
  core.startGroup(name);
  execSync(command, { stdio: "inherit"});
  core.endGroup();
};

const main = async () => {
  try {
    const platform = os.platform();
    const installPath = ["~/.esy/source"];
    const installKey = `source-${platform}-${cacheKey}`;
    core.startGroup("Restoring install cache");
    const installCacheKey = await cache.restoreCache(installPath, installKey, []);
    if (installCacheKey) {
      console.log("Restored the install cache")
    }
    core.endGroup();
    
    run("Run esy install", "esy install");
    
    if (!installCacheKey) {
      await cache.saveCache(installPath, installKey);
    }

    const ESY_FOLDER = esyPrefix ? esyPrefix : path.join(os.homedir(), ".esy");
    const esy3 = fs
      .readdirSync(ESY_FOLDER)
      .filter((name: string) => name.length > 0 && name[0] === "3")
      .sort()
      .pop();
    
    const depsPath = [path.join(ESY_FOLDER, esy3, "i")];
    const buildKey = `build-${platform}-${cacheKey}`;
    const restoreKeys = [
      `build-${platform}-`,
      `build-`,
    ];
    
    core.startGroup("Restoring build cache");
    const buildCacheKey = await cache.restoreCache(depsPath, buildKey, restoreKeys);
    if (buildCacheKey) {
      console.log("Restored the build cache")
    }
    core.endGroup();
    
    if (!buildCacheKey) {
      run("Run esy build-dependencies", "esy build-dependencies");
    } 
    
    run("Run esy build", "esy build");
    
    if (!buildCacheKey) {
      await cache.saveCache(depsPath, buildKey);
    }

    if (!buildCacheKey) {
      run("Run esy cleanup", "esy cleanup .");
    }
  } catch (e) {
    core.setFailed(e.message);
  }
};

main();
