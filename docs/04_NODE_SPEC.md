# AI Canvas 节点规范 v1.0

## 1. 节点分类

第一版只做 4 个节点：

```text
Image
Prompt
Image Chat
Multi Generate
```

## 2. 数据节点

数据节点不显示 Run。

包括：

```text
Image
Prompt
```

顶部只显示清空按钮。

无内容时：

```text
清空按钮灰色，不可点击
```

有内容时：

```text
清空按钮深色，可点击
```

## 3. AI 节点

AI 节点显示 Run。

包括：

```text
Image Chat
Multi Generate
```

顶部显示：

```text
Run 按钮
清空按钮
```

第一版 Run 按钮只做视觉和状态，不接真实 API。

状态：

```text
Idle
Running
Completed
Failed
```

## 4. Image 节点

用途：图片输入。

```text
类型：数据节点
Run：无
输入/输出类型：Image
连接点颜色：绿色
```

支持：

```text
拖入图片
粘贴图片
下载图片
清空图片
```

## 5. Prompt 节点

用途：文本输入。

```text
类型：数据节点
Run：无
输入/输出类型：Text
连接点颜色：黄色
```

支持：

```text
输入文本
清空文本
```

## 6. Image Chat 节点

用途：图片分析，后期调用 AI。

```text
类型：AI 节点
Run：有
输入：Image / 绿色
输出：Text / 黄色
```

第一版只显示空结果区域。

## 7. Multi Generate 节点

用途：多图生成，后期调用 AI。

```text
类型：AI 节点
Run：有
输入：Text / 黄色
可选输入：Image / 绿色
输出：Image / 绿色
```

第一版只显示 2x2 图片占位区。

## 8. 节点端口

端口必须有类型：

```ts
type PortType = "image" | "text";
```

每个端口：

```ts
interface Port {
  id: string;
  type: PortType;
  direction: "input" | "output";
  color: string;
}
```

连接判断：

```ts
sourcePort.type === targetPort.type
```

否则禁止连接。
