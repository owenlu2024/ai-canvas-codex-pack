const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const stageDir = path.join(buildDir, "win-web-stage");
const runtimeDepsDir = path.join(buildDir, "win-web-runtime-deps");
const nodeCacheDir = path.join(buildDir, "win-node-runtime");
const releaseDir = path.join(root, "release");
const packageDir = path.join(releaseDir, "AICanvas-Web-Win11-x64");
const standaloneDir = path.join(root, ".next", "standalone");
const staticDir = path.join(root, ".next", "static");
const publicDir = path.join(root, "public");

const sharpPackage = require(path.join(root, "node_modules", "sharp", "package.json"));
const sharpVersion = sharpPackage.version;
const nodeVersion = process.env.WIN_NODE_VERSION || "v20.18.3";
const nodeZipName = `node-${nodeVersion}-win-x64.zip`;
const nodeZipUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeZipName}`;
const nodeZipPath = path.join(nodeCacheDir, nodeZipName);

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

function ensureWindowsNodeRuntime() {
  const extractedDir = path.join(nodeCacheDir, `node-${nodeVersion}-win-x64`);
  const nodeExe = path.join(extractedDir, "node.exe");
  if (fs.existsSync(nodeExe)) return extractedDir;

  if (!fs.existsSync(nodeZipPath)) {
    console.log(`正在下载 Windows Node 运行环境：${nodeZipUrl}`);
    execFileSync(process.execPath, ["-e", `
      const https = require("https");
      const fs = require("fs");
      const path = require("path");
      const url = ${JSON.stringify(nodeZipUrl)};
      const target = ${JSON.stringify(nodeZipPath)};
      fs.mkdirSync(path.dirname(target), { recursive: true });
      function get(currentUrl) {
        https.get(currentUrl, (res) => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            console.error("下载失败：HTTP " + res.statusCode);
            process.exit(1);
          }
          const file = fs.createWriteStream(target);
          res.pipe(file);
          file.on("finish", () => file.close());
        }).on("error", (error) => {
          console.error(error.message);
          process.exit(1);
        });
      }
      get(url);
    `], { stdio: "inherit" });
  }

  fs.rmSync(extractedDir, { force: true, recursive: true });
  execFileSync("unzip", ["-q", nodeZipPath, "-d", nodeCacheDir], { cwd: root, stdio: "inherit" });
  ensureExists(nodeExe, "Windows Node 运行环境");
  return extractedDir;
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

function npmPack(packageSpec) {
  fs.mkdirSync(runtimeDepsDir, { recursive: true });
  const output = execFileSync("npm", ["pack", packageSpec, "--json"], {
    cwd: runtimeDepsDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const packed = JSON.parse(output)[0];
  return path.join(runtimeDepsDir, packed.filename);
}

function copyPackedPackage(packageName, packageSpec, targetNodeModules) {
  const tgz = npmPack(packageSpec);
  const extractedPackageDir = path.join(runtimeDepsDir, "package");
  fs.rmSync(extractedPackageDir, { force: true, recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", runtimeDepsDir], { cwd: root, stdio: "inherit" });
  copyDir(extractedPackageDir, path.join(targetNodeModules, ...packageName.split("/")));
  fs.rmSync(extractedPackageDir, { force: true, recursive: true });
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
    throw new Error(`Windows 网页包里不能保留符号链接：\n${symlinks.slice(0, 20).join("\n")}`);
  }
}

function writeLauncher(targetDir) {
  const launcherDir = path.join(targetDir, "launcher");
  fs.mkdirSync(launcherDir, { recursive: true });
  fs.writeFileSync(path.join(launcherDir, "start-ai-canvas.cjs"), `const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const root = path.resolve(__dirname, "..");
const standaloneRoot = path.join(root, "app", ".next", "standalone");
const serverEntry = path.join(standaloneRoot, "server.js");
const dataDir = path.join(root, "AI-Canvas-Data", ".ai-canvas");
const logDir = path.join(root, "logs");
const logPath = path.join(logDir, "startup.log");

fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(logPath, "AI Canvas startup log\\n" + new Date().toISOString() + "\\n\\n", "utf8");

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

function writeLogLine(values) {
  const line = values.map((value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
  fs.appendFileSync(logPath, line + "\\n", "utf8");
}

console.log = (...values) => {
  originalLog(...values);
  writeLogLine(values);
};

console.error = (...values) => {
  originalError(...values);
  writeLogLine(values);
};

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 3000;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("本地网页服务启动超时。"));
          return;
        }
        setTimeout(check, 300);
      });
      request.setTimeout(2000, () => request.destroy());
    };
    check();
  });
}

function openBrowser(url) {
  spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
}

(async () => {
  if (!fs.existsSync(serverEntry)) {
    throw new Error("找不到网页运行文件：" + serverEntry);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const port = await findFreePort();
  const url = "http://127.0.0.1:" + port;

  process.env.NODE_ENV = "production";
  process.env.HOSTNAME = "127.0.0.1";
  process.env.PORT = String(port);
  process.env.AI_CANVAS_DATA_DIR = dataDir;
  process.env.AI_CANVAS_PUBLIC_DIR = path.join(standaloneRoot, "public");

  console.log("");
  console.log("AI Canvas 网页版正在启动...");
  console.log("数据保存位置：" + dataDir);
  console.log("启动日志：" + logPath);
  console.log("网页地址：" + url);
  console.log("");
  console.log("请不要关闭这个窗口。关闭窗口后，本地网页服务会停止。");
  console.log("");

  require(serverEntry);
  await waitForServer(url);
  openBrowser(url);
})().catch((error) => {
  console.error("");
  console.error("AI Canvas 启动失败：");
  console.error(error && error.stack ? error.stack : String(error));
  console.error("");
  console.error("请把这个日志文件发给开发者排查：" + logPath);
  process.exit(1);
});
`, "utf8");

  const writeWindowsBat = (fileName, lines) => {
    fs.writeFileSync(path.join(targetDir, fileName), `${lines.join("\r\n")}\r\n`, "ascii");
  };

  writeWindowsBat("Start-AI-Canvas-Web.bat", [
    "@echo off",
    "setlocal",
    "title AI Canvas Web",
    "cd /d \"%~dp0\"",
    "echo.",
    "echo Starting AI Canvas Web...",
    "echo Current folder: %CD%",
    "echo.",
    "if not exist \"runtime\\node\\node.exe\" (",
    "  echo ERROR: Missing runtime\\node\\node.exe",
    "  echo Please extract the full zip package first.",
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    "if not exist \"launcher\\start-ai-canvas.cjs\" (",
    "  echo ERROR: Missing launcher\\start-ai-canvas.cjs",
    "  echo Please extract the full zip package first.",
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    "\"%~dp0runtime\\node\\node.exe\" \"%~dp0launcher\\start-ai-canvas.cjs\"",
    "echo.",
    "echo AI Canvas has stopped.",
    "echo If startup failed, please send logs\\startup.log to the developer.",
    "echo.",
    "pause"
  ]);

  writeWindowsBat("Check-AI-Canvas.bat", [
    "@echo off",
    "setlocal",
    "title AI Canvas Check",
    "cd /d \"%~dp0\"",
    "echo.",
    "echo AI Canvas diagnostic check",
    "echo Current folder: %CD%",
    "echo.",
    "if exist \"runtime\\node\\node.exe\" (",
    "  echo OK: runtime\\node\\node.exe exists",
    ") else (",
    "  echo ERROR: runtime\\node\\node.exe is missing",
    ")",
    "if exist \"launcher\\start-ai-canvas.cjs\" (",
    "  echo OK: launcher\\start-ai-canvas.cjs exists",
    ") else (",
    "  echo ERROR: launcher\\start-ai-canvas.cjs is missing",
    ")",
    "if exist \"app\\.next\\standalone\\server.js\" (",
    "  echo OK: app\\.next\\standalone\\server.js exists",
    ") else (",
    "  echo ERROR: app\\.next\\standalone\\server.js is missing",
    ")",
    "echo.",
    "echo Node version:",
    "\"%~dp0runtime\\node\\node.exe\" -v",
    "echo.",
    "echo If this window appears, BAT files can run on this computer.",
    "echo Send a screenshot of this window if Start-AI-Canvas-Web.bat still does not work.",
    "echo.",
    "pause"
  ]);
}

function writeReadme(targetDir) {
  fs.writeFileSync(path.join(targetDir, "README.txt"), `AI Canvas Windows 11 网页版

使用方法：
1. 先把整个文件夹解压出来。
2. 双击“Start-AI-Canvas-Web.bat”。
3. 正常情况下会自动打开浏览器。
4. 使用时不要关闭黑色启动窗口，关闭后网页服务会停止。

本包已经包含运行所需环境：
- Windows x64 Node.js 20 LTS 运行环境
- AI Canvas 已构建好的网页文件
- 必要的 Next.js/React/sharp 运行依赖

数据保存位置：
AI-Canvas-Data\\.ai-canvas\\

如果启动失败：
1. 不要放在压缩包里直接运行，必须先解压。
2. 建议解压到短路径，例如 D:\\AICanvas-Web\\
3. 如果 Windows 安全软件拦截，请允许 Start-AI-Canvas-Web.bat 和 runtime\\node\\node.exe 运行。
4. 如果浏览器没有自动打开，请复制启动窗口里的 http://127.0.0.1:端口 地址到浏览器。
5. 如果双击没有任何反应，请先双击 Check-AI-Canvas.bat，并把窗口截图发给开发者。
6. 如果仍然失败，请把 logs\\startup.log 发给开发者排查。

API Key 不会从打包电脑自动带入。
如需使用 AI 生图，请在软件设置里重新填写。
`, "utf8");
}

function assertReleaseFiles(targetDir) {
  const required = [
    path.join(targetDir, "Start-AI-Canvas-Web.bat"),
    path.join(targetDir, "Check-AI-Canvas.bat"),
    path.join(targetDir, "README.txt"),
    path.join(targetDir, "runtime", "node", "node.exe"),
    path.join(targetDir, "launcher", "start-ai-canvas.cjs"),
    path.join(targetDir, "app", ".next", "standalone", "server.js"),
    path.join(targetDir, "app", ".next", "standalone", ".next", "BUILD_ID"),
    path.join(targetDir, "app", ".next", "standalone", ".next", "static"),
    path.join(targetDir, "app", ".next", "standalone", "public"),
    path.join(targetDir, "app", ".next", "standalone", "node_modules", "next", "package.json"),
    path.join(targetDir, "app", ".next", "standalone", "node_modules", "react", "package.json"),
    path.join(targetDir, "app", ".next", "standalone", "node_modules", "react-dom", "package.json"),
    path.join(targetDir, "app", ".next", "standalone", "node_modules", "@img", "sharp-win32-x64", "package.json")
  ];

  for (const file of required) ensureExists(file, "Windows 网页包运行文件");

  const localDataDir = path.join(targetDir, "app", ".next", "standalone", ".ai-canvas");
  if (fs.existsSync(localDataDir)) {
    throw new Error(`不应该把本机数据目录打进 Windows 网页包：${localDataDir}`);
  }
}

async function main() {
  ensureExists(standaloneDir, "Next.js standalone 输出");
  ensureExists(staticDir, "Next.js static 输出");
  ensureExists(publicDir, "public 静态资源");

  fs.rmSync(stageDir, { force: true, recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });

  copyDir(standaloneDir, path.join(stageDir, "app", ".next", "standalone"));
  copyDir(staticDir, path.join(stageDir, "app", ".next", "standalone", ".next", "static"));
  copyDir(publicDir, path.join(stageDir, "app", ".next", "standalone", "public"));
  fs.rmSync(path.join(stageDir, "app", ".next", "standalone", ".ai-canvas"), { force: true, recursive: true });

  const standaloneNodeModules = path.join(stageDir, "app", ".next", "standalone", "node_modules");
  copyResolvedPackage("styled-jsx", standaloneNodeModules);
  copyResolvedPackage("client-only", standaloneNodeModules);
  copyResolvedPackage("@swc/helpers", standaloneNodeModules);
  copyResolvedPackage("@next/env", standaloneNodeModules);
  copyResolvedPackage("scheduler", standaloneNodeModules);
  copyResolvedPackage("postcss", standaloneNodeModules);
  copyResolvedPackage("nanoid", standaloneNodeModules);
  copyResolvedPackage("picocolors", standaloneNodeModules);
  copyResolvedPackage("source-map-js", standaloneNodeModules);
  copyResolvedPackage("caniuse-lite", standaloneNodeModules);
  copyResolvedPackage("detect-libc", standaloneNodeModules);
  copyResolvedPackage("semver", standaloneNodeModules);
  copyResolvedPackage("@img/colour", standaloneNodeModules);
  copyPackedPackage("@img/sharp-win32-x64", `@img/sharp-win32-x64@${sharpVersion}`, standaloneNodeModules);

  const nodeRuntimeDir = ensureWindowsNodeRuntime();
  copyDir(nodeRuntimeDir, path.join(stageDir, "runtime", "node"));
  writeLauncher(stageDir);
  writeReadme(stageDir);
  ensureNoSymlinks(stageDir);

  fs.rmSync(packageDir, { force: true, recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  copyDir(stageDir, packageDir);
  ensureNoSymlinks(packageDir);
  assertReleaseFiles(packageDir);

  const zipPath = path.join(releaseDir, "AICanvas-Web-Win11-x64.zip");
  fs.rmSync(zipPath, { force: true });
  execFileSync("zip", ["-qr", path.basename(zipPath), path.basename(packageDir)], {
    cwd: releaseDir,
    stdio: "inherit"
  });
  execFileSync("zip", ["-T", path.basename(zipPath)], {
    cwd: releaseDir,
    stdio: "inherit"
  });

  console.log("\nWindows 11 网页版一键运行包已生成并通过完整性检查：");
  console.log(zipPath);
  console.log(path.join(packageDir, "Start-AI-Canvas-Web.bat"));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
