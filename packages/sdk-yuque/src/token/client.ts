import asyncPool from 'tiny-async-pool'
import { out, request, RequestOptions } from '@elog/shared'
import { getProps, processHtmlRaw, processMarkdownRaw, processWordWrap } from '../utils'
import {
  YuQueResponse,
  DocUnite,
  YuqueDoc,
  YuqueDocDetail,
  YuqueDocProperties,
  FormatExtFunction,
  YuqueDocListResponse,
} from '../types'
import { DocDetail, YuqueCatalog, DocCatalog } from '@elog/types'
import { FormatExt } from './format-ext'
import { YuqueWithTokenConfig } from './types'
import { IllegalityDocFormat } from '../const'
import fs from 'fs'
import path from 'path'

/** 默认语雀API 路径 */
const DEFAULT_API_URL = 'https://www.yuque.com/api/v2'

/** 请求间隔（毫秒），避免触发 API 限制 */
const REQUEST_INTERVAL = 200

/** 最大重试次数 */
const MAX_RETRY = 3

class YuqueClient {
  config: YuqueWithTokenConfig
  namespace: string
  catalog: YuqueCatalog[] = []
  formatExtCtx: FormatExtFunction

  constructor(config: YuqueWithTokenConfig) {
    this.config = config
    this.config.token = config.token || process.env.YUQUE_TOKEN!
    if (!this.config.token || !this.config.repo || !this.config.login) {
      out.err('缺少参数', '缺少语雀配置信息')
      out.info('请查阅Elog配置文档: https://elog.1874.cool/notion/write-platform')
      process.exit(-1)
    }
    this.namespace = `${config.login}/${config.repo}`
    if (config.formatExt) {
      const formatExt = new FormatExt(config.formatExt)
      this.formatExtCtx = formatExt.getFormatExt()
    } else {
      this.formatExtCtx = processWordWrap
    }
  }

  /**
   * 获取文档列表临时缓存文件名
   * 根据 cachePath 生成唯一文件名，避免多配置冲突
   */
  private getDocListCacheFileName(): string {
    if (this.config.cachePath) {
      // 从 cachePath 提取基础名称，例如 elog-online.cache.json -> elog-online.doc-list-cache.json
      const basename = path.basename(this.config.cachePath, '.json')
      return `.elog.${basename}.doc-list-cache.json`
    }
    // 使用 namespace 生成唯一文件名，例如 user/repo -> user-repo.doc-list-cache.json
    const safeNamespace = this.namespace.replace('/', '-')
    return `.elog.${safeNamespace}.doc-list-cache.json`
  }

  /**
   * send api request to yuque
   * @param api
   * @param reqOpts
   * @param custom
   */
  async request<T>(api: string, reqOpts: RequestOptions, custom?: boolean): Promise<T> {
    const { token } = this.config
    let baseUrl = this.config.baseUrl || DEFAULT_API_URL
    if (baseUrl.endsWith('/')) {
      // 删除最后一个斜杠
      baseUrl = baseUrl.slice(0, -1)
    }
    const url = `${baseUrl}/${api}`
    const opts: RequestOptions = {
      headers: {
        'X-Auth-Token': token,
      },
      ...reqOpts,
    }
    if (custom) {
      const res = await request<T>(url, opts)
      return res.data
    }
    const res = await request<YuQueResponse<T>>(url, opts)
    if (res.status !== 200) {
      // @ts-ignore
      if (res.status === 404 && res.data?.message === 'book not found') {
        out.err('配置错误', '知识库不存在，请检查配置')
        out.info('请参考配置文档：https://elog.1874.cool/notion/write-platform')
      } else {
        // @ts-ignore
        out.err(res.data?.message || res)
      }
      process.exit()
    }
    return res.data.data
  }

  /**
   * 获取目录
   */
  async getToc() {
    return this.request<YuqueCatalog[]>(`repos/${this.namespace}/toc`, {
      method: 'GET',
    })
  }

  /**
   * 保存文档列表到临时缓存文件
   */
  private saveDocListCache(list: YuqueDoc[], offset: number, total: number) {
    try {
      const cacheFileName = this.getDocListCacheFileName()
      const cachePath = path.join(process.cwd(), cacheFileName)
      const cacheData = {
        list,
        offset,
        total,
        timestamp: Date.now(),
      }
      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8')
    } catch (e) {
      out.warning('无法保存文档列表缓存', String(e))
    }
  }

  /**
   * 从临时缓存文件加载文档列表
   */
  private loadDocListCache(): { list: YuqueDoc[]; offset: number; total: number } | null {
    try {
      const cacheFileName = this.getDocListCacheFileName()
      const cachePath = path.join(process.cwd(), cacheFileName)
      if (!fs.existsSync(cachePath)) {
        return null
      }
      const cacheContent = fs.readFileSync(cachePath, 'utf-8')
      const cacheData = JSON.parse(cacheContent)
      out.access(
        '恢复进度',
        `发现未完成的文档列表获取，已获取 ${cacheData.list.length}/${cacheData.total} 篇文档`,
      )
      return cacheData
    } catch (e) {
      out.warning('无法加载文档列表缓存', String(e))
      return null
    }
  }

  /**
   * 删除文档列表临时缓存文件
   */
  private clearDocListCache() {
    try {
      const cacheFileName = this.getDocListCacheFileName()
      const cachePath = path.join(process.cwd(), cacheFileName)
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath)
      }
    } catch (e) {
      // 忽略删除错误
    }
  }

  /**
   * 带重试的请求方法
   */
  private async requestWithRetry<T>(
    api: string,
    reqOpts: RequestOptions,
    retryCount = 0,
  ): Promise<T> {
    try {
      // 添加请求间隔，避免触发 API 限制
      if (retryCount > 0 || this.requestCount > 0) {
        await this.sleep(REQUEST_INTERVAL)
      }
      this.requestCount++
      return await this.request<T>(api, reqOpts, true)
    } catch (error: any) {
      if (retryCount < MAX_RETRY) {
        out.warning('请求失败', `${error.message}，正在重试 (${retryCount + 1}/${MAX_RETRY})...`)
        // 指数退避
        await this.sleep(REQUEST_INTERVAL * Math.pow(2, retryCount))
        return this.requestWithRetry(api, reqOpts, retryCount + 1)
      }
      throw error
    }
  }

  /** 请求计数器 */
  private requestCount = 0

  /** 延迟函数 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 获取文章列表(不带详情) - 支持断点续传
   */
  async getDocList() {
    // 获取目录信息
    this.catalog = await this.getToc()

    // 尝试从缓存恢复
    const cachedData = this.loadDocListCache()
    let list: YuqueDoc[] = cachedData?.list || []
    let startOffset = cachedData?.offset || 0
    let total = cachedData?.total || 0

    this.requestCount = 0
    const self = this

    /**
     * 获取单页文档列表
     */
    const getList = async (offset: number) => {
      const pageSize = 100 // 设置分页大小为100
      out.info('获取文档列表', `正在获取第 ${offset + 1}-${offset + pageSize} 篇...`)

      try {
        const res = await self.requestWithRetry<YuqueDocListResponse>(
          `repos/${this.namespace}/docs`,
          {
            method: 'GET',
            data: { offset, limit: pageSize },
          },
        )

        list.push(...res.data)
        total = res.meta.total

        // 每获取一页就保存一次缓存
        self.saveDocListCache(list, offset + pageSize, total)

        out.info(
          '获取进度',
          `已获取 ${list.length}/${total} 篇文档列表 (API 调用: ${self.requestCount} 次)`,
        )

        // 检查是否还有下一页
        if (res.meta.total > offset + pageSize) {
          await getList(offset + pageSize)
        }
      } catch (error: any) {
        out.err('获取文档列表失败', error.message)
        out.info(
          '进度已保存',
          `已获取 ${list.length} 篇文档，下次运行将从第 ${list.length + 1} 篇继续`,
        )
        throw error
      }
    }

    try {
      await getList(startOffset)
      // 获取成功后清除临时缓存
      this.clearDocListCache()
      out.access('文档列表获取完成', `共 ${list.length} 篇文档`)
    } catch (error) {
      // 错误已经在 getList 中处理，这里需要确保缓存已保存
      this.saveDocListCache(list, list.length, total)
      throw error
    }

    return list
  }

  /**
   * 获取文章详情
   */
  async getDocDetail(slug: string) {
    const yuqueDoc = await this.request<YuqueDocDetail>(`repos/${this.namespace}/docs/${slug}`, {
      method: 'GET',
      data: { raw: 1 },
    })
    const docInfo = yuqueDoc as DocUnite
    docInfo.doc_id = yuqueDoc.slug
    const find = this.catalog.find((item) => item.slug === yuqueDoc.slug)
    if (find) {
      let catalogPath = []
      let parentId = find.parent_uuid
      for (let i = 0; i < find.depth - 1; i++) {
        const current = this.catalog.find((item) => item.uuid === parentId)!
        parentId = current.parent_uuid
        const catalog: DocCatalog = {
          title: current.title,
          doc_id: yuqueDoc.slug,
        }
        catalogPath.push(catalog)
      }
      docInfo.catalog = catalogPath.reverse()
    }
    // 处理HTML
    docInfo.body_html = processHtmlRaw(docInfo.body_html)
    return docInfo
  }

  /**
   * 获取文章详情列表 - 支持边下载边处理回调
   * @param cachedDocs 文档列表
   * @param ids 需要下载的文档 ID 列表
   * @param onDocDownloaded 单篇文档下载完成回调（可选），用于实时处理文档
   */
  async getDocDetailList(
    cachedDocs: YuqueDoc[],
    ids: string[],
    onDocDownloaded?: (article: DocDetail, index: number, total: number) => Promise<void> | void,
  ) {
    let articleList: DocDetail[] = []
    let docs = cachedDocs
    if (ids.length) {
      // 取交集，过滤不需要下载的page
      docs = docs.filter((doc) => {
        const exist = ids.indexOf(doc.slug) > -1
        if (!exist) {
          out.info('跳过下载', doc.title)
        }
        return exist
      })
    }
    if (!docs?.length) {
      out.access('跳过', '没有需要下载的文章')
      return articleList
    }
    out.info('待下载数', String(docs.length))
    out.access('开始下载文档...')
    docs = docs.map((item, index) => ({ ...item, _index: index + 1 } as YuqueDoc))

    let completedCount = 0

    const promise = async (doc: YuqueDoc) => {
      out.info(`下载文档 ${doc._index}/${docs.length}   `, doc.title)
      let article = await this.getDocDetail(doc.slug)
      if (!doc.format && IllegalityDocFormat.some((item) => item === article.format)) {
        out.warning('注意', `【${article.title}】为不支持的文档格式`)
      }
      article.body_original = article.body
      // 解析出properties
      const { body, properties } = getProps(article)
      // 处理语雀字符串
      let newBody = processMarkdownRaw(body)
      // 处理换行/自定义处理
      newBody = this.formatExtCtx({ ...article, body: newBody })
      article.properties = properties as YuqueDocProperties
      // 替换body
      article.body = newBody
      article.updated = new Date(article.updated_at).getTime()
      articleList.push(article)

      // 实时回调处理
      if (onDocDownloaded) {
        completedCount++
        out.info('处理进度', `${completedCount}/${docs.length} 篇文档已处理`)
        try {
          await onDocDownloaded(article, completedCount, docs.length)
        } catch (error: any) {
          out.warning('回调处理失败', `${article.title}: ${error.message}`)
          // 继续处理下一篇，不中断整个流程
        }
      }
    }
    await asyncPool(this.config.limit || 3, docs, promise)
    out.info('已下载数', String(articleList.length))
    return articleList
  }
}

export default YuqueClient
