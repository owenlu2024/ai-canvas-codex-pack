# Windows 11 网页版一键运行包

## 打包命令

在项目根目录执行：

```bash
pnpm install
pnpm run build:win-web
```

成功后会生成：

```text
release/AICanvas-Web-Win11-x64.zip
```

把这个 zip 发到 Windows 11 后，先完整解压，再双击：

```text
Start-AI-Canvas-Web.bat
```

正常效果：

1. 会出现一个启动窗口。
2. 会自动启动本地网页服务。
3. 会自动打开浏览器访问 `http://127.0.0.1:端口`。

## 包内包含的环境

这个包不需要 Windows 用户提前安装 Node、npm、pnpm。

包里已经包含：

- Windows x64 Node.js 20 LTS 运行环境
- 已构建好的 Next.js 网页文件
- Next.js / React 运行依赖
- Windows 版 sharp 图片处理依赖

## 数据保存位置

Windows 版会把本地数据保存到解压目录内：

```text
AI-Canvas-Data/.ai-canvas/
```

这样移动整个解压文件夹时，项目数据也会跟着走。

## 注意

- 不要在 zip 压缩包里直接双击运行，必须先解压。
- 建议解压到短路径，例如 `D:\AICanvas-Web\`。
- 启动后不要关闭黑色启动窗口，关闭后本地网页服务会停止。
- 如果双击启动文件没有任何反应，请先双击 `Check-AI-Canvas.bat` 做诊断。
- 如果启动失败，请把解压目录里的 `logs/startup.log` 发给开发者排查。
- 打包文件不会自动带入本机 `.ai-canvas/api-settings.local.json`，避免把 API Key 一起打包出去。
