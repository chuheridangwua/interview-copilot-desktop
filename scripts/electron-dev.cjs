const net = require("node:net");
const { spawn } = require("node:child_process");
const electronPath = require("electron");

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
let viteProcess;
let electronProcess;
let shuttingDown = false;

function waitForPort(port, host = "127.0.0.1", timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`等待 Vite 端口 ${host}:${port} 超时`));
          return;
        }
        setTimeout(tryConnect, 300);
      });
    }
    tryConnect();
  });
}

function stopAll(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProcess && !electronProcess.killed) electronProcess.kill();
  if (viteProcess && !viteProcess.killed) viteProcess.kill();
  process.exit(code);
}

async function main() {
  viteProcess = spawn(npmCommand, ["run", "dev"], { stdio: "inherit", env: process.env });
  viteProcess.once("exit", (code) => {
    if (!shuttingDown) stopAll(code ?? 1);
  });
  await waitForPort(1420);
  electronProcess = spawn(electronPath, ["."], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_DEV: "1",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:1420",
    },
  });
  electronProcess.once("exit", (code) => stopAll(code ?? 0));
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
main().catch((error) => {
  console.error(error);
  stopAll(1);
});
