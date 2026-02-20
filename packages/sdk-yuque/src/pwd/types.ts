export interface YuqueWithPwdConfig {
  /** 语雀账号（邮箱/手机号/登录名） */
  username?: string
  /** 语雀账号密码 */
  password?: string
  /** 语雀知识库口令（仓库访问密码） */
  repoPassword?: string
  /** 浏览器会话 cookie（用于口令页/验证码等场景） */
  cookie?: string
  host?: string
  login: string
  repo: string
  linebreak?: boolean
  /** 保留公式代码而不是以图片形式 */
  latexCode?: boolean
  onlyPublic?: boolean
  onlyPublished?: boolean
  /** 下载并发数 */
  limit?: number
}

export interface YuqueLogin {
  ok: boolean
  goto: string
  user: {
    id: string
    login: string
    name: string
    description: string
  }
}

export interface YuqueLoginCookie {
  data: string
  time: number
}
