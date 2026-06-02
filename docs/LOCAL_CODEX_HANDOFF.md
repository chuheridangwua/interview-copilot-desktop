# Interview Copilot Desktop 交接文档

当前项目已经从 Tauri 迁移为 Electron + React。Windows 本机继续开发不再需要 Rust/Cargo。

## 当前目标

做一个 Windows 桌面客户端，用于真实面试时监听系统输出声音，将面试官问题送到豆包/火山引擎流式 ASR，并从内置问题库中匹配 Top 3 问题和答案。

核心约束：

- 只监听系统声音，不采集麦克风。
- 问题库内置到客户端，不读取 Windows 本地 Markdown。
- 不实时调用大模型做匹配，本地毫秒级匹配。
- 通过空格推进：开始监听 -> 锁定答案 -> 清空进入下一题。
- API Key 只从环境变量读取，不写入仓库。

## 技术栈

- Electron main process：窗口、IPC、豆包 ASR WebSocket、题库解析、匹配事件分发。
- Electron preload：调用 `getDisplayMedia` 获取系统音频，转成 `16kHz / 16bit / mono / PCM`，按 200ms 分包发给 main process。
- React/Vite/TypeScript：桌面控制台 UI。
- electron-builder：Windows `.exe` / `.msi` 打包。

## 关键文件

```text
package.json
README.md
.github/workflows/build-windows-client.yml
resources/question_bank_embedded.md
resources/icon.ico
electron/main.cjs
electron/preload.cjs
electron/backend/doubaoAsr.cjs
electron/backend/questionMatcher.cjs
scripts/electron-dev.cjs
scripts/test-question-matcher.mjs
scripts/build-windows.ps1
src/App.tsx
src/desktopClient.ts
src/styles.css
```

`src-tauri/` 目录暂时保留为历史实现参考，不再参与 npm 脚本和 GitHub Actions 打包。

## Windows 本机开发

Windows 只需要 Node/npm：

```powershell
node -v
npm -v
```

配置豆包 Key，使用轮换后的新 Key：

```powershell
setx DOUBAO_API_KEY "你的新Key"
```

执行 `setx` 后重新打开 PowerShell。

启动开发客户端：

```powershell
cd E:\CLX\project\interview-copilot-desktop
npm install
npm run client
```

打安装包：

```powershell
npm run client:build
```

或：

```powershell
.\scripts\build-windows.ps1
```

产物位置：

```text
release/*.exe
release/*.msi
```

## Linux Remote SSH 开发

Linux 远程环境可用于写代码、跑前端和匹配测试：

```bash
cd /home/ubuntu/offer/interview-copilot-desktop
npm install
npm run dev
npm run test:matcher
npm run build
```

`npm run dev` 只是 Vite 前端，不是桌面端。浏览器里提示“未检测到 Electron 桌面端后端”是正常的。

如果 Linux 有图形桌面，可尝试：

```bash
npm run client
```

但真实系统声音采集必须在 Windows 本机验证。

## 已验证

在 Linux 上已通过：

```bash
npm run test:matcher
npm run build
npx electron-builder --dir --linux dir
npm ci --dry-run --no-audit --no-fund
```

`npx electron-builder --dir --linux dir` 只验证 Electron 打包配置，不代表 Windows 系统声音已验证。

## 真实端到端待验证

需要在 Windows 本机继续验证：

- Electron `getDisplayMedia` 是否能稳定拿到系统 loopback 音频。
- 顶部音量是否随会议声音变化。
- PCM 发送豆包 ASR 后是否持续返回 partial/final。
- 空格流程是否符合真实面试节奏。
- `.exe` / `.msi` 安装包运行是否能读取环境变量。

## 使用流程

1. 打开会议软件并让面试官声音从 Windows 系统输出设备播放。
2. 启动客户端：`npm run client`。
3. 按空格或点击开始监听。
4. Electron 会请求屏幕/系统音频捕获权限，选择屏幕并允许系统音频。
5. 状态栏音量不是 0%，说明采到了声音。
6. 面试官说完一段问题后，左侧新增问题记录，中间出 Top 3，右侧出答案。
7. 再按空格锁定当前答案。
8. 再按空格清空当前题，进入下一题。

## 安全事项

用户之前在聊天里贴过豆包 API Key，真实使用前必须轮换。不要把 Key 写入：

- 代码
- README
- `.env`
- GitHub Actions
- 日志

当前代码只读取：

```text
DOUBAO_API_KEY
VOLCENGINE_ASR_API_KEY
```
