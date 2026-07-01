# Windows 11 解压即用打包说明

## 打包命令

在项目根目录执行：

```bash
pnpm install
pnpm run build:win-unpacked
```

成功后会生成：

```text
release/AICanvas-win32-x64/
```

把整个 `AICanvas-win32-x64` 文件夹压缩成 zip，发到 Windows 11 后解压，双击：

```text
AICanvas.exe
```

建议直接解压到短路径，例如：

```text
D:\AICanvas\
```

不要解压到层级很深、中文目录很多的路径里，否则 Windows 可能触发路径长度限制。

## 数据保存位置

Windows 版会把本地数据保存到 exe 同级目录：

```text
AI-Canvas-Data/.ai-canvas/
```

这样移动整个解压文件夹时，项目数据也会跟着走。

## 注意

- 打包文件不会自动带入本机 `.ai-canvas/api-settings.local.json`，避免把 API Key 一起打包出去。
- 如果要迁移旧项目数据，可以把旧 `.ai-canvas` 文件夹复制到 Windows 解压目录下的 `AI-Canvas-Data/.ai-canvas/`。
