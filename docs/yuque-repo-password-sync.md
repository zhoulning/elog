# 语雀口令库同步说明（`yuque-repo-pwd`）

本文档说明如何使用 Elog 同步“语雀口令知识库”，包括：

- 本次功能改动点
- 如何手动获取 `YUQUE_COOKIE`
- 如何配置 `elog` 和 `.env`
- 如何执行同步

## 1. 本次改动内容

本次新增了语雀口令库同步能力，支持通过浏览器会话 Cookie 访问口令知识库。

主要改动如下：

- 新增写作平台：`yuque-repo-pwd`
- `yuque-pwd` 配置新增字段：
  - `repoPassword`（语雀知识库口令）
  - `cookie`（浏览器会话 Cookie）
- 当提供 `YUQUE_COOKIE` 时，优先使用 Cookie 登录，不再依赖账号密码接口流程

涉及代码文件：

- `packages/core/src/const.ts`
- `packages/core/src/client.ts`
- `packages/sdk-yuque/src/pwd/types.ts`
- `packages/sdk-yuque/src/pwd/client.ts`
- `packages/cli/src/utils/gen-config-file.ts`

## 2. 如何获取 `YUQUE_COOKIE`（手动）

### 2.1 浏览器准备

1. 打开目标语雀知识库页面（例如 `https://www.yuque.com/aaron-wecc3/dhluml`）
2. 输入知识库口令，确认已经能看到知识库内容

### 2.2 获取 Cookie

1. 打开开发者工具（Chrome/Edge：`F12` 或 `Cmd+Option+I`）
2. 切换到 `Console`
3. 执行：

```js
document.cookie
```

4. 复制输出的整串字符串（例如 `a=...; b=...; c=...`）

> 注意：`YUQUE_COOKIE` 会过期，过期后需要重新获取。

## 3. 如何配置

### 3.1 `.elog.env` 配置示例

```bash
# 目标库信息
YUQUE_LOGIN=aaron-wecc3
YUQUE_REPO=dhluml

# 知识库口令
YUQUE_REPO_PASSWORD=ghkq

# 浏览器里获取的 document.cookie
YUQUE_COOKIE=这里粘贴完整cookie字符串
```

### 3.2 `elog-online.config.js` 配置示例

```js
module.exports = {
  write: {
    platform: 'yuque-repo-pwd',
    'yuque-repo-pwd': {
      repoPassword: process.env.YUQUE_REPO_PASSWORD,
      cookie: process.env.YUQUE_COOKIE,
      login: process.env.YUQUE_LOGIN,
      repo: process.env.YUQUE_REPO,
      onlyPublic: false,
      onlyPublished: false,
    },
  },
  deploy: {
    platform: 'local',
    local: {
      outputDir: './markdown-online',
      filename: 'title',
      format: 'markdown',
      catalog: true,
    },
  },
  image: {
    enable: false,
    platform: 'local',
  },
}
```

## 4. 执行同步

```bash
node /Users/zln/code/elog/packages/cli/bin/elog.js sync -e .elog.env -a elog-online.cache.json -c elog-online.config.js
```

## 5. 常见问题

### 5.1 提示口令验证失败

- 确认 `YUQUE_REPO_PASSWORD` 正确
- 确认 `YUQUE_LOGIN` 与 `YUQUE_REPO` 正确

### 5.2 提示未登录/权限不足

- 重新从浏览器获取 `document.cookie`，更新 `YUQUE_COOKIE`
- 确认你当前浏览器会话确实能打开该知识库

### 5.3 `YUQUE_COOKIE` 安全建议

- 不要提交到公共仓库
- 使用后可定期更新
- 仅在受控环境保存
