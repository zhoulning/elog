# Elog 断点续传功能改造文档

## 背景

当语雀知识库包含上万篇文档时，同步过程会遇到以下问题：

1. **API 调用限制**：语雀 API 在几千次调用后会触发限流，导致同步中断
2. **无法断点续传**：程序中断后重新运行会从头开始，陷入死循环
3. **进度丢失**：已下载的内容未及时保存，中断后全部丢失

## 改造目标

实现完整的断点续传机制，确保：
- 每下载一篇文档就立即写入本地
- 每处理完一批就更新缓存
- 中断后可以从上次位置继续

## 改造内容

### 1. 文档列表获取阶段断点续传

**文件**：`packages/sdk-yuque/src/token/client.ts`

**改动**：
- 新增临时缓存文件 `.elog.doc-list-cache.json`
- 每获取一页文档列表就保存一次缓存
- 下次运行时从上次中断位置继续

**新增方法**：
```typescript
private saveDocListCache(list, offset, total)  // 保存列表缓存
private loadDocListCache()                     // 加载列表缓存
private clearDocListCache()                    // 清除列表缓存
private requestWithRetry()                     // 带重试的请求
private sleep(ms)                              // 延迟函数
```

**新增常量**：
```typescript
const DOC_LIST_CACHE_FILE = '.elog.doc-list-cache.json'
const REQUEST_INTERVAL = 200    // 请求间隔 200ms
const MAX_RETRY = 3             // 最大重试次数
```

### 2. 文档详情下载阶段实时回调

**文件**：
- `packages/sdk-yuque/src/token/client.ts`
- `packages/sdk-yuque/src/token/core.ts`
- `packages/sdk-yuque/src/pwd/client.ts`
- `packages/sdk-yuque/src/pwd/core.ts`

**改动**：
- `getDocDetailList` 方法新增可选回调参数 `onDocDownloaded`
- 每下载完一篇文档就调用回调，支持实时处理
- 支持 Token 方式和密码登录方式

**方法签名**（core.ts 和 client.ts）：
```typescript
// 底层 client 实现
async getDocDetailList(
  cachedDocs: YuqueDoc[],
  ids: string[],
  onDocDownloaded?: (article: DocDetail, index: number, total: number) => Promise<void> | void,
)
```

**方法签名**（core.ts 封装）：
```typescript
// Token/密码方式的 core 封装（对外调用）
async getDocDetailList(
  ids: string[],
  onDocDownloaded?: (article: DocDetail, index: number, total: number) => Promise<void> | void,
)
```

### 3. 核心流程边下载边写

**文件**：`packages/core/src/client.ts`

**改动**：
- 新增边下载边写模式，实时处理每篇文档
- 本地部署且未启用图片处理时自动启用

**新增方法**：
```typescript
private async processAndWriteSingleArticle(article, idMap)  // 处理并写入单篇文章
```

**模式判断**：
```typescript
const enableStreamWrite =
  this.config.deploy.platform === DeployPlatformEnum.LOCAL &&
  !this.config.image?.enable &&
  this.config.write.platform === WritePlatform.YUQUE
```

## 缓存机制说明

### 缓存文件

| 文件 | 用途 | 生命周期 |
|---|---|---|
| `.elog.{cache-name}.doc-list-cache.json` | 文档列表临时缓存 | 获取列表期间，完成后删除 |
| `{cache-name}.cache.json` | 文档详情缓存（主缓存） | 长期保存，用于增量同步 |

**多配置隔离**：每个配置使用独立的缓存文件名，互不干扰。

### 缓存文件名规则

**临时缓存文件名**根据主缓存文件名自动生成：

| 主缓存文件 | 临时缓存文件 |
|---|---|
| `elog.cache.json` (默认) | `.elog.elog.doc-list-cache.json` |
| `elog-online.cache.json` | `.elog.elog-online.doc-list-cache.json` |
| `elog-offline.cache.json` | `.elog.elog-offline.doc-list-cache.json` |

**未指定 cachePath 时**，使用语雀知识库的 `login/repo` 生成唯一文件名：

```
.elog.{login}-{repo}.doc-list-cache.json
```

### 缓存内容

**`.elog.doc-list-cache.json`**：
```json
{
  "list": [...],      // 已获取的文档列表
  "offset": 500,       // 下次开始的偏移量
  "total": 10000,      // 文档总数
  "timestamp": 1234567890
}
```

**`elog.cache.json`**：
```json
{
  "docs": [...],       // 所有已下载文档的缓存信息
  "catalog": [...]     // 目录结构
}
```

## 同步流程

### 边下载边写模式

```
1. 获取文档列表（支持断点续传）
   ├─ 从缓存恢复进度（如果有）
   ├─ 分页获取列表
   ├─ 每页保存临时缓存
   └─ 完成后清除临时缓存

2. 下载文档详情（边下载边写）
   ├─ 下载第 1 篇 → 写入 MD → 更新缓存
   ├─ 下载第 2 篇 → 写入 MD → 更新缓存
   ├─ 下载第 3 篇 → 写入 MD → 更新缓存
   └─ ...

3. 清理工作
   └─ 删除已不存在的文档（如果启用强制同步）
```

### 批量模式（原模式）

当启用图片处理或非本地部署时，使用原有批量模式：

```
1. 获取文档列表
2. 批量下载文档详情
3. 批量处理图片
4. 批量写入文件
5. 更新缓存
```

## 触发条件

边下载边写模式自动启用的条件：

1. 部署平台为 `local`（本地部署）
2. 未启用图片处理（`image.enable !== true`）
3. 写作平台为语雀 Token 方式（`yuque`）或密码登录方式（`yuque-pwd`）

不满足以上条件时，自动使用批量模式。

## 使用方式

### 正常使用

无需修改配置，边下载边写模式会自动启用。

### 多配置示例

```bash
# 配置1：线上环境
elog sync -e .elog.env -a elog-online.cache.json -c elog-online.config.js

# 配置2：本地测试
elog sync -e .elog.local.env -a elog-local.cache.json -c elog-local.config.js
```

每个配置使用独立的缓存文件：
- `elog-online` → `.elog.elog-online.doc-list-cache.json` + `elog-online.cache.json`
- `elog-local` → `.elog.elog-local.doc-list-cache.json` + `elog-local.cache.json`

### 清除缓存重新开始

如果想完全重新同步某个配置：

```bash
# 删除主缓存
rm elog-online.cache.json

# 删除列表临时缓存（如果存在）
rm .elog.elog-online.doc-list-cache.json

# 重新同步
elog sync -e .elog.env -a elog-online.cache.json -c elog-online.config.js
```

### 从断点恢复

直接重新运行 sync 命令即可：

```bash
elog sync -e .elog.env -a elog-online.cache.json -c elog-online.config.js
```

程序会自动检测缓存并从上次位置继续。

## 日志输出

### 列表获取阶段

```
获取文档列表 正在获取第 1-100 篇...
获取进度 已获取 100/10000 篇文档列表 (API 调用: 1 次)
获取文档列表 正在获取第 101-200 篇...
获取进度 已获取 200/10000 篇文档列表 (API 调用: 2 次)
...
文档列表获取完成 共 10000 篇文档
```

### 详情下载阶段（边下载边写模式）

```
边下载边写模式 启用实时处理，每下载一篇文档立即写入
下载文档 1/5000    文章标题
处理进度 1/5000 篇文档已处理
生成文档 文章标题.md
下载文档 2/5000    文章标题2
处理进度 2/5000 篇文档已处理
生成文档 文章标题2.md
...
```

### 断点恢复

```
恢复进度 发现未完成的文档列表获取，已获取 3000/10000 篇文档
获取文档列表 正在获取第 3001-3100 篇...
```

## 注意事项

1. **列表临时缓存**：临时缓存文件会在列表获取完成后自动删除，如果中断会保留
2. **多配置隔离**：每个配置使用独立的缓存文件名，不会互相冲突
3. **请求间隔**：每次 API 请求间隔 200ms，避免触发限流
4. **错误重试**：请求失败会自动重试 3 次，使用指数退避策略
5. **兼容性**：未启用图片处理时才使用边下载边写模式，其他情况使用原批量模式

## 改动文件清单

```
packages/sdk-yuque/src/token/client.ts    # Token 方式断点续传 + 下载回调
packages/sdk-yuque/src/token/core.ts      # Token 方式封装层（支持回调）
packages/sdk-yuque/src/token/types.ts     # 类型定义（新增 cachePath）
packages/sdk-yuque/src/pwd/client.ts      # 密码方式断点续传 + 下载回调
packages/sdk-yuque/src/pwd/core.ts        # 密码方式封装层（支持回调）
packages/core/src/client.ts               # 核心流程边下载边写
docs/resumable-sync.md                    # 本文档
```

## 测试建议

1. **小规模测试**：先用小知识库（几十篇文档）测试功能正常
2. **中断测试**：同步过程中手动中断，验证断点恢复
3. **大规模测试**：在完整知识库上测试完整流程
