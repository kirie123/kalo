# packages/ai 构建报 TS2307「Cannot find module './kimi-coding.models.ts'」（models.dev provider key 改名）

## 症状

`kalo-harness/packages/ai` 构建（`npm run build` / `npm run build:offline`，底层 `tsgo`）失败：

```
src/providers/kimi-coding.ts(5,34): error TS2307: Cannot find module './kimi-coding.models.ts' or its corresponding type declarations.
```

报错的是**手写**模块 `src/providers/kimi-coding.ts`，找不到的是它的生成 shard
`src/providers/kimi-coding.models.ts`。

**关键迷惑点**：报错前后 `npm run check:model-data` 照样通过，输出
`Generated model data is valid.`。该检查校验的是生成产物内部一致性
（`models.generated.ts` ↔ `*.models.ts` ↔ `data/*.json`）；改名后聚合器与 shard
是「一致地」都不再包含该 provider，所以检查看不出问题，直到 TS 编译手写模块才炸。

## 快速排查

1. 看 `scripts/generate-models.ts` 里写死的 provider key，与 models.dev 当前目录名对照：

   ```bash
   cd kalo-harness/packages/ai
   grep -n "kimi-code-plan-global\|kimi-for-coding" scripts/generate-models.ts
   ```

   生成器按 `data["<provider>"]?.models` 取值；key 写错或过时，该 provider 模型数
   就是 0，且**静默跳过**，不报错。

2. 重新生成，看该 provider 的产出与 git 状态：

   ```bash
   npm run generate-models
   git status --short src/providers src/models.generated.ts
   ```

   若出现 `D src/providers/kimi-coding.models.ts`（或其它 `*.models.ts` 被删），
   说明生成器这次没有产出该 shard。

3. 确认修复目标是生成器而不是生成产物：`git diff --stat scripts/generate-models.ts`。

## 根因

models.dev 把 provider key `kimi-for-coding` 改名成了
`kimi-code-plan-global`，而 `scripts/generate-models.ts` 仍读老键：

1. `data["kimi-for-coding"]` 取不到 → 该 provider 不再产出模型；
2. 生成器收尾会删除所有本次未再生成的陈旧 shard
   （`rmSync` 掉不在 `generatedShardFiles` 里的 `*.models.ts`）；
3. 于是 `src/providers/kimi-coding.models.ts` 被删，`src/models.generated.ts`
   也不再 import 它；
4. 手写模块 `src/providers/kimi-coding.ts` 仍 `import { KIMI_CODING_MODELS }
   from "./kimi-coding.models.ts"` → import 悬空 → TS2307。

即「改名 → 生成器静默跳过 → 清理陈旧 shard → 手写 import 悬空」四步链条。
前两步不报错，第三步只是文件消失，直到第四步编译才现形。

## 修复

**只改生成器，不要手改生成产物**：

1. 在 `scripts/generate-models.ts` 里把 provider key 更新为新名：

   ```ts
   if (data["kimi-code-plan-global"]?.models) { ... }
   ```

2. 重新生成，让 shard 与聚合器恢复：

   ```bash
   cd kalo-harness/packages/ai
   npm run generate-models
   ```

**禁止**手动改 `src/models.generated.ts` / `src/providers/*.models.ts`，或从 git
恢复被删的 shard——它们是生成产物，下次生成照样被删/覆盖。key 之外若还需别名
或缺失条目兜底，也写在生成器里（见「防复发」的 Cloudflare 变体）。

## 验证

```bash
cd kalo-harness/packages/ai
npm run generate-models      # 退出码 0
git status --short           # 只应剩 scripts/generate-models.ts 被修改，没有 D *.models.ts
npm run check:model-data     # Generated model data is valid.
npm run build:offline        # tsgo 编译通过，不再报 TS2307

cd /d/opensource-project/kalo
bash scripts/build-engine.sh # sidecar 重建成功
```

## 防复发

- `scripts/model-data.ts` 新增 `validateProviderModuleShardImports`，并挂进
  `validateGeneratedModelData`：扫描 `src/providers/` 下所有手写 `.ts`
  （跳过 `*.models.ts`），凡是 import `./<id>.models.ts` 而 `<id>` 不在本次生成
  目录里，直接抛错：

  ```
  Provider modules import generated shards that the catalog no longer generates: ...
  A models.dev provider key was probably renamed or dropped: update scripts/generate-models.ts
  so the provider is generated again.
  ```

  这样 `npm run check:model-data`（构建前置检查）会在生成阶段就拦下悬空 import，
  而不是等到 TS 编译。

- 同类变体：models.dev 会间歇性丢掉 `cloudflare-ai-gateway` 的 `workers-ai/*`
  条目。本仓做法不是在生成产物里手工补，而是在生成器里按 `workers-ai/` 前缀把
  `cloudflare-workers-ai` 的条目并入 gateway 目录（`scripts/generate-models.ts`
  中 `cloudflareAIGatewayModels` 的合并逻辑）。上游目录再漂移时按同样套路在生成
  器加兜底，不要碰生成产物。