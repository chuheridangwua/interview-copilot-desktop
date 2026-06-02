import { spawnSync } from "node:child_process";

function hasCommand(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore", shell: process.platform === "win32" });
  return result.status === 0;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!hasCommand("node")) {
  fail("未检测到 Node.js。请先安装 Node.js 22 或 LTS 版本，然后重新打开 PowerShell。");
}

if (!hasCommand("npm")) {
  fail("未检测到 npm。请确认 Node.js 安装完整。");
}

console.log("Electron 客户端环境检查通过。");
