# Windows 11 继续开发指南

## 1. 安装开发环境

在 Windows 11 上安装：

- Git for Windows
- Node.js 20 LTS（64 位）
- Visual Studio Code

安装完成后，打开“开始菜单”，搜索并打开 **PowerShell**，依次执行：

```powershell
node -v
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm -v
```

正常会看到 Node.js 版本号，以及 `11.7.0` 的 pnpm 版本号。

如果 `corepack enable` 提示权限不足，请右键 PowerShell，选择“以管理员身份运行”，再执行一次。

## 2. 解压项目

把源码 ZIP 完整解压到较短的英文路径，例如：

```text
D:\AI-Canvas-Codex-Pack\
```

不要直接在 ZIP 压缩包内运行，也尽量避免路径过深。

## 3. 安装依赖

在项目文件夹空白处按住 Shift 并点击鼠标右键，选择“在终端中打开”，然后执行：

```powershell
pnpm install
```

正常完成时不会出现红色报错，并会生成 `node_modules` 文件夹。

如果下载依赖很慢，可先切换 npm 镜像：

```powershell
pnpm config set registry https://registry.npmmirror.com
pnpm install
```

## 4. 配置本地环境

只有接入真实 AI 接口时才需要执行：

```powershell
Copy-Item .env.local.example .env.local
notepad .env.local
```

把 `.env.local` 里的示例 API Key 替换为你自己的 Key。不要把 `.env.local` 发给别人或提交到 Git。

## 5. 启动开发模式

在项目根目录的 PowerShell 中执行：

```powershell
pnpm dev
```

正常会看到类似：

```text
Local: http://localhost:3000
```

按住 Ctrl 点击该地址，或在浏览器输入 `http://localhost:3000`。

停止开发服务器时，在 PowerShell 中按：

```text
Ctrl + C
```

## 6. 修改后检查

开发完成后执行：

```powershell
pnpm build
```

构建成功且没有红色错误，说明项目可以正常打包。

## 常见问题

### PowerShell 不允许执行脚本

执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

输入 `Y` 确认，然后关闭并重新打开 PowerShell。

### 安装依赖时报证书或代理错误

先检查 Windows“设置 → 网络和 Internet → 代理”中的代理是否仍然有效。不要长期关闭 SSL 校验，也不要把账号、API Key 或代理密码发到公开位置。

### 端口 3000 被占用

Next.js 通常会自动改用 3001。请打开终端里实际显示的 `Local` 地址。
