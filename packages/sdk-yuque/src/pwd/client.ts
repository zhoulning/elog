import asyncPool from 'tiny-async-pool'
import { out, request, RequestOptions } from '@elog/shared'
import { encrypt, getProps } from '../utils'
import { YuQueResponse, YuqueDoc, YuqueDocProperties } from '../types'
import { DocDetail, YuqueCatalog, DocCatalog } from '@elog/types'
import { JSDOM } from 'jsdom'
import { YuqueWithPwdConfig, YuqueLogin, YuqueLoginCookie } from './types'
import { IllegalityDocFormat } from '../const'

/** 默认语雀API 路径 */
const DEFAULT_HOST = 'https://www.yuque.com'

class YuqueClient {
  config: YuqueWithPwdConfig
  namespace: string
  baseUrl: string
  bookId: string = ''
  docList: YuqueDoc[] = []
  catalog: YuqueCatalog[] = []
  cookie: YuqueLoginCookie | undefined

  constructor(config: YuqueWithPwdConfig) {
    this.config = config
    this.config.username = config.username || process.env.YUQUE_USERNAME
    this.config.password = config.password || process.env.YUQUE_PASSWORD
    this.config.repoPassword = config.repoPassword || process.env.YUQUE_REPO_PASSWORD
    this.config.cookie = config.cookie || process.env.YUQUE_COOKIE
    if (!this.config.login || !this.config.repo) {
      out.err('缺少参数', '缺少语雀配置信息')
      process.exit(-1)
    }
    if (
      !this.config.cookie &&
      !this.config.repoPassword &&
      (!this.config.username || !this.config.password)
    ) {
      out.err('缺少参数', '缺少语雀账号密码/知识库口令/浏览器Cookie')
      process.exit(-1)
    }
    this.namespace = `${this.config.login}/${this.config.repo}`
    this.baseUrl = this.config.host || DEFAULT_HOST
    if (this.baseUrl.endsWith('/')) {
      // 删除最后一个斜杠
      this.baseUrl = this.baseUrl.slice(0, -1)
    }
  }

  /**
   * 登陆
   */
  async login() {
    if (this.config.cookie) {
      this.cookie = {
        time: Date.now(),
        data: this.config.cookie,
      }
      out.info('使用浏览器Cookie登录')
      return
    }

    if (this.config.username && this.config.password) {
      const loginInfo = {
        login: this.config.username,
        password: encrypt(this.config.password),
        loginType: 'password',
      }

      const res = await request<YuQueResponse<YuqueLogin>>(
        `${this.baseUrl}/api/mobile_app/accounts/login?language=zh-cn`,
        {
          method: 'post',
          data: loginInfo,
          headers: {
            Referer: this.baseUrl + '/login?goto=https%3A%2F%2Fwww.yuque.com%2Fdashboard',
            origin: this.baseUrl,
            'user-agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20G81 YuqueMobileApp/1.0.2 (AppBuild/650 Device/Phone Locale/zh-cn Theme/light YuqueType/public)',
          },
        },
      )
      if (res.status !== 200) {
        out.err('语雀登陆失败')
        // @ts-ignore
        out.err(res)
        process.exit(-1)
      }
      this.updateCookie(res.headers['set-cookie'])
      out.info('语雀登陆成功')
    } else {
      out.info('跳过账号登录', '使用知识库口令模式')
    }

    if (this.config.repoPassword) {
      await this.unlockRepoByPassword()
    }
  }

  private updateCookie(cookie?: string | string[]) {
    if (!cookie) return
    const next = Array.isArray(cookie) ? cookie.join('; ') : cookie
    this.cookie = {
      time: Date.now(),
      data: this.cookie?.data ? `${this.cookie.data}; ${next}` : next,
    }
  }

  private async unlockRepoByPassword() {
    const repoUrl = `${this.baseUrl}/${this.namespace}`
    const firstPage = await request<string>(repoUrl, {
      method: 'get',
      dataType: 'text',
      headers: {
        cookie: this.cookie?.data,
      },
    })
    this.updateCookie(firstPage.headers['set-cookie'])

    const firstDom = new JSDOM(`${firstPage.data}`)
    const bookExists = !!firstDom?.window?.appData?.book
    if (bookExists) {
      firstDom.window.close()
      out.info('知识库口令', '知识库已可访问，无需再次解锁')
      return
    }

    const passwordInput = firstDom.window.document.querySelector('input[type="password"]') as any
    const formEl = passwordInput?.closest('form') as any
    if (!passwordInput || !formEl) {
      firstDom.window.close()
      out.err('知识库口令验证失败', '未找到语雀口令表单，可能页面结构已变更')
      process.exit(-1)
    }

    const formData: Record<string, any> = {}
    const hiddenInputs = Array.from(formEl.querySelectorAll('input[type="hidden"]')) as any[]
    hiddenInputs.forEach((input) => {
      const name = input.name
      const value = input.value
      if (name) formData[name] = value
    })
    const passwordField = passwordInput.name || 'password'
    formData[passwordField] = this.config.repoPassword

    const action = formEl.getAttribute('action') || `/${this.namespace}`
    const method = (formEl.getAttribute('method') || 'post').toLowerCase()
    const actionUrl = new URL(action, `${this.baseUrl}/`).toString()
    firstDom.window.close()

    const submitRes = await request<string>(actionUrl, {
      method: method as any,
      data: formData,
      contentType: 'form',
      dataType: 'text',
      headers: {
        cookie: this.cookie?.data,
        Referer: repoUrl,
        origin: this.baseUrl,
      },
    })
    this.updateCookie(submitRes.headers['set-cookie'])

    const verifyRes = await request<string>(repoUrl, {
      method: 'get',
      dataType: 'text',
      headers: {
        cookie: this.cookie?.data,
      },
    })
    this.updateCookie(verifyRes.headers['set-cookie'])
    const verifyDom = new JSDOM(`${verifyRes.data}`)
    const unlocked = !!verifyDom?.window?.appData?.book
    verifyDom.window.close()
    if (!unlocked) {
      out.err('知识库口令验证失败', '请检查 YUQUE_REPO_PASSWORD 是否正确')
      process.exit(-1)
    }
    out.info('知识库口令验证成功')
  }

  /**
   * send api request to yuque
   * @param api
   * @param reqOpts
   * @param custom
   */
  async request<T>(api: string, reqOpts: RequestOptions, custom?: boolean): Promise<T> {
    const url = `${this.baseUrl}/${api}`
    const opts: RequestOptions = {
      headers: {
        cookie: this.cookie?.data,
      },
      ...reqOpts,
    }
    if (!opts.headers?.cookie) {
      out.err('未登录语雀!')
      process.exit(-1)
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
    try {
      const res = await this.request(this.namespace, { method: 'get', dataType: 'text' }, true)
      const dom = new JSDOM(`${res}`, { runScripts: 'dangerously' })
      const { book } = dom?.window?.appData || {}
      dom.window.close()
      if (!book) {
        out.warning('爬取语雀目录失败，请稍后重试')
        process.exit(-1)
      }
      this.bookId = book.id
      return book?.toc || []
    } catch (e: any) {
      out.warning('爬取语雀目录失败，请稍后重试', e.message)
      process.exit(-1)
    }
  }

  /**
   * 获取文章列表(不带详情)
   */
  async getDocList() {
    // 获取目录信息
    this.catalog = await this.getToc()
    const docList = await this.request<YuqueDoc[]>(`api/docs`, {
      method: 'GET',
      data: { book_id: this.bookId },
    })
    this.docList = docList
    return docList
  }

  /**
   * 获取文章详情
   */
  async getDocDetail(slug: string) {
    const yuqueDocString = await this.request<string>(
      `${this.namespace}/${slug}/markdown`,
      {
        method: 'GET',
        data: {
          attachment: true,
          latexcode: this.config.latexCode, // 是否保留latex代码
          anchor: false,
          linebreak: !!this.config.linebreak,
        },
        dataType: 'text',
      },
      true,
    )
    const doc = this.docList.find((item) => item.slug === slug)!
    const docInfo = {
      body: yuqueDocString,
      doc_id: slug,
      catalog: [] as any[],
      ...doc,
    } as any
    const find = this.catalog.find((item) => item.url === slug)
    if (find) {
      let catalogPath = []
      let parentId = find.parent_uuid
      for (let i = 0; i < find.level; i++) {
        const current = this.catalog.find((item) => item.uuid === parentId)!
        parentId = current.parent_uuid
        const catalog: DocCatalog = {
          title: current.title,
          doc_id: slug,
        }
        catalogPath.push(catalog)
      }
      docInfo.catalog = catalogPath.reverse()
    }
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
      // 解析出properties
      const { body, properties } = getProps(article, true)
      // 处理换行/自定义处理
      article.properties = properties as YuqueDocProperties
      article.body = body
      article.body_original = body
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
