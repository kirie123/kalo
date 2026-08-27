# npm registry 证书过期导致 npx 失败

## 症状

```bash
$ npx tsc --noEmit
npm error code CERT_HAS_EXPIRED
npm error request to https://registry.npm.taobao.org/tsc failed, reason: certificate has expired
```

## 快速排查

1. 确认报错指向的 registry（`npm config get registry`）
2. 如果是 `registry.npm.taobao.org` 且证书过期 → 是镜像源问题，不是项目问题

## 根因

本机 npm 配置了淘宝镜像源（`registry.npm.taobao.org`），该域名证书过期。`npx` 找不到本地包时会回源下载，触发证书校验失败。

## 修复

- 项目内已有 `node_modules` 时：直接用本地二进制 `node_modules/.bin/tsc`，不走 npm
- 或切换官方源：`npm config set registry https://registry.npmjs.org/`

## 验证

```bash
node_modules/.bin/tsc --version   # 应正常输出版本号
node_modules/.bin/tsc --noEmit    # 应正常完成
```
