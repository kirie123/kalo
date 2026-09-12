# 自定义 Provider 的模型「读不到图」（模型定义没声明 image）

## 症状

在自定义 provider（`models.json` 里配的中转/网关）上给模型发截图，模型回答「无法读取到图片」「我看不到图」，或者干脆装作收到了文字。

同一张图直接 `curl` 打网关却完全能看懂。

## 快速排查

1. 看引擎怎么判定这个模型的能力：

   ```bash
   pi --list-models opus
   # provider  model          context  max-out  thinking  images
   # pz        claude-opus-5  200K     16.4K    no        no      ← images no
   ```

   `images no` 就是命中本文。

2. 直接验证网关本身支不支持视觉（换成自己的 baseUrl / key）：

   ```bash
   node -e 'const fs=require("fs");console.log(JSON.stringify({model:"claude-opus-5",max_tokens:200,
     messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/png",
     data:fs.readFileSync("shot.png").toString("base64")}},{type:"text",text:"描述这张图"}]}]}))' > body.json
   curl -s -X POST "$BASE/v1/messages" -H "content-type: application/json" \
     -H "anthropic-version: 2023-06-01" -H "authorization: Bearer $KEY" -d @body.json
   ```

   能准确描述内容 → 网关没问题（本文场景）；401/400 或答非所问 → 先按 401 那篇排查。

3. 想看引擎到底发了什么：在 `--mode json` 输出里搜占位符。命中本文会看到

   ```
   (image omitted: model does not support images)
   [Current model does not support images. The image will be omitted from this request.]
   ```

## 根因

`models.json` 的模型定义里没写 `input`，引擎按 `definition.input ?? ["text"]` 处理（`provider-composer.ts` 的 `modelFromJson`），于是该模型被当成**纯文本模型**。随后：

- 用户粘贴的图 → `packages/ai/src/api/transform-messages.ts` 的 `downgradeUnsupportedImages()` 把 image 块换成占位文本；
- `read` 工具读图 → `packages/coding-agent/src/core/tools/read.ts` 的 `getNonVisionImageNote()` 拒绝附图。

两种情况都变成「模型收到一段文字说这里本来有张图」，所以模型只能回答读不到图。

桌面端的「添加/编辑模型」表单只写 `id` / `contextWindow`，**没有图片能力开关**，因此凡是从 UI 新建的自定义 provider 都会踩这个坑。

## 修复

> 0.6.x 起桌面端「编辑模型」弹窗已带「模型支持图片输入」开关，新建的模型不再栽在这里；
> 同一次改动还修了「不思考 / 最大输出 16K / 手工字段被抹」三个同源问题，见
> [custom-provider-model-capabilities.md](custom-provider-model-capabilities.md)。

给该模型加上 `input`（只加给确实支持视觉的模型）：

```json
{
  "providers": {
    "pz": {
      "api": "anthropic-messages",
      "baseUrl": "https://gateway.example.com/yanjiuyuan",
      "authHeader": true,
      "models": [
        { "id": "claude-opus-5", "contextWindow": 200000, "input": ["text", "image"] }
      ]
    }
  }
}
```

- 每个模型一份，`input` 与 `contextWindow` 平级。
- 改完**新开一个会话**（引擎只在 spawn 时读 `models.json`）。
- 桌面端 UI 编辑同一 provider、且模型 id 不变时会保留该字段（保存时以既有模型元数据为底再改 `contextWindow`）；但**新增**的模型 id 不会自动带上，需要手工补。

## 验证

1. `pi --list-models <model>` 的 `images` 列应变成 `yes`。
2. 让模型读一张图，应能答出图中内容：

   ```bash
   pi --print --no-session -ne -ns --model pz/claude-opus-5 \
     "用 read 工具读取 <某张图.png>，只回答顶部标题文字"
   ```

3. **别只看它答得像不像**——用**内容已知**的图做判定。生成一张图案图（例如左中右三个纯色块，颜色由你定）再问顺序，答对才算真看到：

   ```bash
   # 生成 pattern.png（蓝/黄/紫三色块）后用上面同一条命令问颜色顺序
   # 期望输出：蓝色，黄色，紫色
   ```

   实测：修复前模型答「读不到图」，修复后按顺序答对三色，且能准确描述真实截图里的导航文字与侧栏条目。
