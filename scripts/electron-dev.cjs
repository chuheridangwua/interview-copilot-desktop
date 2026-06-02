const net = require("node:net");
const { execFileSync, spawn } = require("node:child_process");
const electronPath = require("electron");

const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npmSpawnOptions = isWindows ? { shell: true } : {};
let viteProcess;
let electronProcess;
let shuttingDown = false;

function findListeningPidsOnWindows(port) {
  const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP") continue;
    const [_, localAddress, __, state, pid] = parts;
    if (state === "LISTENING" && localAddress.endsWith(`:${port}`)) pids.add(pid);
  }
  return [...pids];
}

function releasePort(port) {
  if (!isWindows) return;
  let pids = [];
  try {
    pids = findListeningPidsOnWindows(port);
  } catch (error) {
    console.warn(`[interview-copilot] 检查端口 ${port} 占用失败：${error.message}`);
    return;
  }
  for (const pid of pids) {
    if (pid === String(process.pid)) continue;
    console.log(`[interview-copilot] 端口 ${port} 被进程 ${pid} 占用，正在结束旧进程...`);
    execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "inherit" });
  }
}

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
  releasePort(1420);
  viteProcess = spawn(npmCommand, ["run", "dev"], { stdio: "inherit", env: process.env, ...npmSpawnOptions });
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
