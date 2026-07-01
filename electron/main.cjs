const { app, BrowserWindow, dialog } = require("electron");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const isPackaged = app.isPackaged;
const appRoot = isPackaged ? app.getAppPath() : path.join(__dirname, "..");
const standaloneRoot = path.join(appRoot, ".next", "standalone");
const serverEntry = path.join(standaloneRoot, "server.js");

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
          reject(new Error("本地服务启动超时。"));
          return;
        }
        setTimeout(check, 300);
      });

      request.setTimeout(2000, () => {
        request.destroy();
      });
    };

    check();
  });
}

async function startNextServer() {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`找不到 Next.js 运行文件：${serverEntry}`);
  }

  const port = await findFreePort();
  const portableDataDir = path.join(path.dirname(process.execPath), "AI-Canvas-Data");

  process.env.NODE_ENV = "production";
  process.env.HOSTNAME = "127.0.0.1";
  process.env.PORT = String(port);
  process.env.AI_CANVAS_DATA_DIR = path.join(portableDataDir, ".ai-canvas");
  process.env.AI_CANVAS_PUBLIC_DIR = path.join(standaloneRoot, "public");

  fs.mkdirSync(process.env.AI_CANVAS_DATA_DIR, { recursive: true });
  require(serverEntry);

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url);
  return url;
}

async function createWindow() {
  try {
    const url = await startNextServer();
    const win = new BrowserWindow({
      backgroundColor: "#f5f5f2",
      height: 920,
      minHeight: 720,
      minWidth: 1120,
      show: false,
      title: "AI Canvas",
      width: 1480,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    win.once("ready-to-show", () => {
      win.maximize();
      win.show();
    });
    await win.loadURL(url);
  } catch (error) {
    dialog.showErrorBox("AI Canvas 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});
