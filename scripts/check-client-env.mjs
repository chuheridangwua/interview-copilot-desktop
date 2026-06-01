import { spawnSync } from "node:child_process";

const isBuild = process.argv.includes("--build");

function hasCommand(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore", shell: process.platform === "win32" });
  return result.status === 0;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (process.platform !== "win32") {
  fail([
    "这个项目第一版是 Windows 桌面客户端，系统声音采集走 Windows WASAPI loopback。",
    `当前系统是 ${process.platform}，不能在这里启动真正的客户端采集系统声音。`,
    "",
    "请在 Windows 机器上运行：",
    "  npm install",
    "  npm run client",
    "",
    "如果只是检查匹配算法，可以继续在当前环境运行：",
    "  npm run test:matcher",
  ].join("\n"));
}

if (!hasCommand("rustc") || !hasCommand("cargo")) {
  fail([
    "没有检测到 Rust/Cargo，所以 Tauri 桌面客户端无法编译启动。",
    "",
    "请先在 Windows 安装：",
    "  1. Rust: https://rustup.rs/",
    "  2. Visual Studio Build Tools，并勾选 Desktop development with C++",
    "  3. Microsoft Edge WebView2 Runtime",
    "",
    "安装后重新打开 PowerShell，确认：",
    "  rustc --version",
    "  cargo --version",
    "",
    `然后运行：npm run ${isBuild ? "client:build" : "client"}`,
  ].join("\n"));
}

console.log("客户端环境检查通过，准备启动 Tauri 桌面客户端。");
