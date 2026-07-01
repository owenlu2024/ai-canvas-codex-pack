const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const stageDir = path.join(buildDir, "win-stage");
const winRuntimeDepsDir = path.join(buildDir, "win-runtime-deps");
const releaseDir = path.join(root, "release");
const standaloneDir = path.join(root, ".next", "standalone");
const staticDir = path.join(root, ".next", "static");
const electronVersion = require(path.join(root, "node_modules", "electron", "package.json")).version;
const sharpVersion = require(path.join(root, "node_modules", "sharp", "package.json")).version;

function copyDir(from, to) {
  fs.cpSync(from, to, {
    dereference: true,
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.DS_Store`)
  });
}

function ensureExists(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(`缺少 ${label}：${target}`);
  }
}

function findPackageJson(packageName) {
  const directPath = path.join(root, "node_modules", packageName, "package.json");
  if (fs.existsSync(directPath)) return directPath;

  const pnpmDir = path.join(root, "node_modules", ".pnpm");
  const packageParts = packageName.split("/");
  const packageDirName = packageParts[packageParts.length - 1];
  const packageJsonSuffix = path.join("node_modules", ...packageParts, "package.json");

  for (const entry of fs.readdirSync(pnpmDir)) {
    if (!entry.startsWith(`${packageDirName}@`) && !entry.startsWith(packageName.replace("/", "+"))) continue;
    const candidate = path.join(pnpmDir, entry, packageJsonSuffix);
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`找不到依赖包：${packageName}`);
}

function copyResolvedPackage(packageName, targetNodeModules) {
  const packageJson = findPackageJson(packageName);
  const packageDir = path.dirname(packageJson);
  copyDir(packageDir, path.join(targetNodeModules, ...packageName.split("/")));
}

function patchStandaloneServer(serverPath) {
  const source = fs.readFileSync(serverPath, "utf8");
  const patched = source.replace(
    "\nprocess.chdir(__dirname)\n",
    "\n// Electron Windows package keeps cwd outside the app folder.\n"
  );
  if (source === patched && source.includes("process.chdir(__dirname)")) {
    throw new Error("server.js 中 process.chdir(__dirname) 替换失败。");
  }
  fs.writeFileSync(serverPath, patched);
}

function findElectronWinZip() {
  const cacheRoot = path.join(process.env.HOME || "", "Library", "Caches", "electron");
  const wantedName = `electron-v${electronVersion}-win32-x64.zip`;
  if (fs.existsSync(cacheRoot)) {
    const stack = [cacheRoot];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        if (entry.isFile() && entry.name === wantedName) return fullPath;
      }
    }
  }
  throw new Error(`找不到 Electron Windows 运行时缓存：${wantedName}`);
}

function ensureWinSharpPackage() {
  fs.mkdirSync(winRuntimeDepsDir, { recursive: true });
  const tgz = path.join(winRuntimeDepsDir, `img-sharp-win32-x64-${sharpVersion}.tgz`);
  if (fs.existsSync(tgz)) return tgz;

  execFileSync("npm", ["pack", `@img/sharp-win32-x64@${sharpVersion}`, "--silent"], {
    cwd: winRuntimeDepsDir,
    stdio: "inherit"
  });
  ensureExists(tgz, "Windows sharp 原生包");
  return tgz;
}

function copyWinSharp(targetNodeModules) {
  const tgz = ensureWinSharpPackage();
  const packageDir = path.join(winRuntimeDepsDir, "package");
  fs.rmSync(packageDir, { force: true, recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", winRuntimeDepsDir], { cwd: root, stdio: "inherit" });
  copyDir(packageDir, path.join(targetNodeModules, "@img", "sharp-win32-x64"));
  fs.rmSync(packageDir, { force: true, recursive: true });
}

function ensureNoSymlinks(target) {
  const symlinks = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(fullPath);
        continue;
      }
      if (entry.isDirectory()) walk(fullPath);
    }
  };
  walk(target);
  if (symlinks.length) {
    throw new Error(`Windows 包里不能保留符号链接：\n${symlinks.slice(0, 20).join("\n")}`);
  }
}

function assertReleaseFiles(appDir) {
  const required = [
    path.join(releaseDir, "AICanvas-win32-x64", "AICanvas.exe"),
    path.join(appDir, "package.json"),
    path.join(appDir, "electron", "main.cjs"),
    path.join(appDir, ".next", "standalone", "server.js"),
    path.join(appDir, ".next", "standalone", ".next", "BUILD_ID"),
    path.join(appDir, ".next", "standalone", ".next", "static"),
    path.join(appDir, ".next", "standalone", "public"),
    path.join(appDir, ".next", "standalone", "node_modules", "next", "package.json"),
    path.join(appDir, ".next", "standalone", "node_modules", "react", "package.json"),
    path.join(appDir, ".next", "standalone", "node_modules", "react-dom", "package.json"),
    path.join(appDir, ".next", "standalone", "node_modules", "styled-jsx", "package.json"),
    path.join(appDir, ".next", "standalone", "node_modules", "client-only", "package.json"),
    path.join(appDir, ".next", "standalone", "node_modules", "@swc", "helpers", "package.json"),
    path.join(appDir, ".next", "standalone", "node_modules", "@next", "env", "package.json"),
    path.join(appDir, ".next", "standalone", "node_modules", "@img", "sharp-win32-x64", "lib", `sharp-win32-x64-${sharpVersion}.node`),
    path.join(appDir, ".next", "standalone", "node_modules", "@img", "sharp-win32-x64", "lib", "libvips-cpp-8.18.3.dll")
  ];

  for (const file of required) ensureExists(file, "Windows 运行文件");

  const localDataDir = path.join(appDir, ".next", "standalone", ".ai-canvas");
  if (fs.existsSync(localDataDir)) {
    throw new Error(`不应该把本机数据目录打进 Windows 包：${localDataDir}`);
  }
}

ensureExists(standaloneDir, "Next.js standalone 输出");
ensureExists(staticDir, "Next.js static 输出");

fs.rmSync(stageDir, { force: true, recursive: true });
fs.mkdirSync(stageDir, { recursive: true });

copyDir(path.join(root, "electron"), path.join(stageDir, "electron"));
copyDir(standaloneDir, path.join(stageDir, ".next", "standalone"));
copyDir(staticDir, path.join(stageDir, ".next", "standalone", ".next", "static"));
copyDir(path.join(root, "public"), path.join(stageDir, ".next", "standalone", "public"));
fs.rmSync(path.join(stageDir, ".next", "standalone", ".ai-canvas"), { force: true, recursive: true });

const standaloneNodeModules = path.join(stageDir, ".next", "standalone", "node_modules");
copyResolvedPackage("styled-jsx", standaloneNodeModules);
copyResolvedPackage("client-only", standaloneNodeModules);
copyResolvedPackage("@swc/helpers", standaloneNodeModules);
copyResolvedPackage("@next/env", standaloneNodeModules);
copyWinSharp(standaloneNodeModules);
patchStandaloneServer(path.join(stageDir, ".next", "standalone", "server.js"));
ensureNoSymlinks(stageDir);

const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  private: true,
  main: "electron/main.cjs",
  productName: "AICanvas"
};
fs.writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(appPackage, null, 2)}\n`);

fs.rmSync(releaseDir, { force: true, recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });

const electronZip = findElectronWinZip();
const unpackedDir = path.join(releaseDir, "AICanvas-win32-x64");
execFileSync("unzip", ["-q", electronZip, "-d", unpackedDir], { cwd: root, stdio: "inherit" });
fs.renameSync(path.join(unpackedDir, "electron.exe"), path.join(unpackedDir, "AICanvas.exe"));
fs.rmSync(path.join(unpackedDir, "resources", "default_app.asar"), { force: true, recursive: true });
fs.rmSync(path.join(unpackedDir, "resources", "app.asar"), { force: true, recursive: true });
fs.rmSync(path.join(unpackedDir, "resources", "app.asar.unpacked"), { force: true, recursive: true });
copyDir(stageDir, path.join(unpackedDir, "resources", "app"));
ensureNoSymlinks(unpackedDir);
assertReleaseFiles(path.join(unpackedDir, "resources", "app"));

const zipPath = path.join(releaseDir, "AICanvas-win11-x64.zip");
fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-qr", "AICanvas-win11-x64.zip", "AICanvas-win32-x64"], {
  cwd: releaseDir,
  stdio: "inherit"
});
execFileSync("zip", ["-T", "AICanvas-win11-x64.zip"], {
  cwd: releaseDir,
  stdio: "inherit"
});

console.log("\nWindows 11 解压即用版本已生成并通过完整性检查：");
console.log(zipPath);
console.log(path.join(unpackedDir, "AICanvas.exe"));
