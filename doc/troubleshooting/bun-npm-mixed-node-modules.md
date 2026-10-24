# bun run build 报 `command not found: tauri`，补上入口后又在 vite 阶段报 `corrupted node_modules`（bun 与 npm 混管 kalo-desktop/node_modules）

## 症状

第一次表现是 tauri 入口直接找不到，构建在最外层就断掉：

```
[ensure-engine] pi engine up to date
$ tauri build
bun: command not found: tauri
error: script "tauri" exited with code 1
```

按下面的办法把入口补齐后，构建能往下走，但会在 `vite build` 阶段换成 bun 的报错（`tsc` 是静默通过的，所以报错位置看着像 tsc）：

```
error: could not find bin metadata file

Bun failed to remap this bin to its proper location within node_modules.
This is an indication of a corrupted node_modules directory.

Please run 'bun install --force' in the project root and try it again.
```

注意上面最后那句建议会把人带偏：`bun install --force` 会让 bun 以 workspace 视角重装 kalo-desktop 的依赖，等于把两份 bin shim 再叠一层，问题只会换形态复发。

## 快速排查

1. 看 `kalo-desktop/node_modules/.bin` 里有没有 `tauri`、`tsc`。包本体（`node_modules/@tauri-apps/cli`、`node_modules/typescript`）在磁盘上而 `.bin` 里没有对应链接，就属于「shim 被 prune 掉」。
2. 用目录 mtime 定位是哪一次操作干的：`kalo-desktop/node_modules/.bin` 的更新时间与 `node_modules` 其余内容明显不一致时，说明后来某次安装只动了链接、没动包。
3. 别只看 `.cmd`。Windows 下 `cmd.exe` 按 PATHEXT **先 `.exe` 后 `.cmd`**，而 `.bin` 里的 `*.exe` / `*.bunx` 是 bun 的产物，会遮挡 npm 的 `vite.cmd` / `vitest.cmd`。逐个直接跑一遍即可确认：

   ```
   kalo-desktop/node_modules/.bin/vite.exe --version   # bun shim → could not find bin metadata file
   kalo-desktop/node_modules/.bin/vite.cmd --version   # npm shim → vite/5.4.21 win32-x64
   ```

## 根因

`kalo-desktop/node_modules` 被两个包管理器同时管理，两套 shim 混在一个目录里：

- 根 `package.json` 声明了 `workspaces: ["kalo-desktop"]`，所以在仓库根跑 `bun install` 会把 kalo-desktop 的依赖一起装成 bun 的隔离布局（根 `node_modules/.bun/` 里那一堆），并把 **bun 自己的 shim**（Windows 上是 `*.exe` + `*.bunx`）写进 `kalo-desktop/node_modules/.bin`。
- kalo-desktop 侧按仓库约定由 npm 管理，自带 `package-lock.json` 与 **npm shim**（无扩展名外壳 + `.cmd` + `.ps1`）。

两个管理器谁最后装谁就重写/删除对方的链接，于是长出两个独立故障：

1. npm 重装/修剪时会把 kalo-desktop 侧它认为 extraneous 的链接删掉 —— `tauri`、`tsc`、`esbuild`、`tailwindcss`、`vite-node` 等一批 shim 集体消失，表现为 `bun: command not found: tauri`（`bun run --cwd kalo-desktop tauri build` 是靠 `kalo-desktop/node_modules/.bin` 解析 `tauri` 的）。
2. bun 的 `*.exe` shim 在 npm 世界里没人清理，长期留着并按 PATHEXT 压住 npm 的 `.cmd`；它需要 bun 的 bin 元数据（隔离布局的 `.bun` 目录）才能把自己 remap 成真正的入口，而当前是 npm 树，于是报 `could not find bin metadata file` / `corrupted node_modules`。报「目录损坏」的其实是 bun shim，npm 的 shim 一直是好的。

## 修复

1. 重链 bin（只动链接、不动包，秒级完成，不要重装整个 node_modules）：

   ```
   cd kalo-desktop && npm rebuild
   ```

2. 确认具体的遮挡入口属于 bun shim，并且对应 npm `.cmd` 已验证可用，再移除该入口。不要通配删除 `.bin` 下全部 `.exe`，其他工具可能提供原生程序。Windows PowerShell 中从仓库根执行，逐个使用已确认的路径，例如：

   ```
   Get-Item -LiteralPath ./kalo-desktop/node_modules/.bin/vite.exe
   # 确认上一步对应的是已诊断的 bun shim 后：
   Remove-Item -LiteralPath ./kalo-desktop/node_modules/.bin/vite.exe
   ```

   历史排查确认过 `vite.exe`、`vitest.exe`、`vitest.bunx` 三个；每台机器仍应独立核实，不能沿用这份列表盲删。

3. 以后在 kalo-desktop 装依赖一律用带 `--workspaces=false` 的形式，别在那儿跑 `bun install`：

   ```
   cd kalo-desktop && npm install --workspaces=false ...
   ```

根 `node_modules/.bin` 下的 `tsc.exe` / `tsserver.exe` 同样是 bun shim，但根 `.bun` 元数据完好、实测可用，可以不动；根 `node_modules/.bun` 与根 shim 是根 workspace 安装的正常产物，不是垃圾，别删。

macOS / Linux 没有 PATHEXT，第 2 种症状（shim 被遮挡）不成立；第 1 种症状（链接被 prune）两边都会出现，修复步骤相同。

## 验证

- `cd kalo-desktop && npm run build` 退出码 0（`tsc` 与 `vite build` 都过）。
- bin 完整性：`kalo-desktop/node_modules/.bin` 里该有的入口都在（至少 `tauri`、`tsc`、`vite`、`vitest`），且具体已诊断的 bun shim 不再遮挡 npm 入口：

  ```
  Get-Command ./kalo-desktop/node_modules/.bin/vite.cmd
  ./kalo-desktop/node_modules/.bin/vite.cmd --version
  ```

- 全量 `bun run build` 跑到出包：`kalo-desktop/src-tauri/target/release/bundle/nsis/Kalo_<版本>_x64-setup.exe`（macOS 为 `.app` + `.dmg`）。
