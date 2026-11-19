/**
 * 供应商的声明式描述。
 *
 * 只放"数据"，不放请求逻辑——请求在 transport.ts 里统一处理。
 * 加一家供应商 = 在这里加一条，不需要改 transport。
 */
import type { AiProviderId } from '@shared/types'

/** 供应商 id 的唯一定义在 @shared/types（设置与 UI 也要用），这里只是别名 */
export type ProviderId = AiProviderId

export interface ReasoningCompat {
  /** thinking: `{ thinking: { type } }`；effort: `reasoning_effort: low|high` */
  style: 'thinking' | 'effort'
  field: string
  /**
   * 不需要思考时怎么处理这个字段：
   * - `disabled`（默认）：显式发 `{type:'disabled'}`（DeepSeek 需要）
   * - `omit`：干脆不发（GLM 的强制思考模型会拒绝 disabled，用默认值最安全）
   */
  whenOff?: 'disabled' | 'omit'
}

export interface ProviderSpec {
  id: ProviderId
  label: string
  baseUrl: string
  paths: { chat: string; models: string }
  /**
   * /models 的差异（P2）：Gemini 的兼容层没有兼容的目录接口，要打 native 端点。
   * 缺省 = `baseUrl + paths.models`、Bearer、OpenAI 形状 `{ data: [...] }`。
   */
  modelsConfig?: {
    url?: string
    auth?: 'bearer' | 'google'
    shape?: 'openai' | 'google'
  }
  /**
   * 作者没有在真机上验证过这一家（没有该地区的账号/Key，见 PLAN-PROVIDERS §9.1）。
   * 只影响 UI 徽标与文档状态表；等真实用户反馈跑通后改成 false。
   */
  unverified?: boolean
  capabilities: {
    /** 能否接收 image_url（base64 data URL） */
    vision: boolean
  }
  compat: {
    maxTokensField: 'max_tokens' | 'max_completion_tokens'
    /** 部分推理模型不接受 temperature */
    temperature: boolean
    /** force: 发送 response_format；prompt-only: 只靠提示词 */
    jsonMode: 'force' | 'prompt-only'
    reasoning: ReasoningCompat | null
    /** image_url 里是否带 detail 字段（OpenAI 系专有） */
    imageDetail: boolean
    /** 缓存命中 token 从哪个字段读 */
    usageCache: 'deepseek' | 'openai' | 'none'
  }
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    paths: { chat: '/chat/completions', models: '/models' },
    capabilities: { vision: true },
    compat: {
      maxTokensField: 'max_tokens',
      temperature: true,
      jsonMode: 'force',
      reasoning: { style: 'thinking', field: 'thinking' },
      imageDetail: true,
      usageCache: 'deepseek'
    }
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    // 作者没有 OpenAI 账号：请求形状按官方文档写，未真机验证
    unverified: true,
    paths: { chat: '/chat/completions', models: '/models' },
    capabilities: { vision: true },
    compat: {
      maxTokensField: 'max_completion_tokens',
      temperature: true,
      jsonMode: 'force',
      reasoning: { style: 'effort', field: 'reasoning_effort' },
      imageDetail: true,
      usageCache: 'openai'
    }
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    // 官方 OpenAI 兼容层；换 native 协议不在计划内
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // 作者没有 Gemini 账号：兼容层是否接受 image_url / response_format 都没实测
    unverified: true,
    // 兼容层（/v1beta/openai）一般不提供 /models，改打 native 目录
    modelsConfig: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      auth: 'google',
      shape: 'google'
    },
    paths: { chat: '/chat/completions', models: '/models' },
    capabilities: { vision: true },
    compat: {
      maxTokensField: 'max_tokens',
      temperature: true,
      // 兼容层对 response_format 的支持未验证，先只靠提示词
      jsonMode: 'prompt-only',
      reasoning: null,
      imageDetail: false,
      usageCache: 'none'
    }
  },
  glm: {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // 2026-11-19 真机验证：4 个调用点通过（glm-5.3-flash，强制思考模型判分约 22s）
    paths: { chat: '/chat/completions', models: '/models' },
    capabilities: { vision: true },
    compat: {
      maxTokensField: 'max_tokens',
      temperature: true,
      jsonMode: 'force',
      // 新版 glm-5.x-flash 强制思考、拒绝 thinking.disabled（实测 400）；
      // 不发这个字段 = 用默认值，老模型默认不思考、新模型默认思考，两条路都不报错
      reasoning: { style: 'thinking', field: 'thinking', whenOff: 'omit' },
      imageDetail: false,
      usageCache: 'none'
    }
  }
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value)
}

export function getProvider(id: string): ProviderSpec {
  if (!isProviderId(id)) throw new Error(`未知的供应商：${id}`)
  return PROVIDERS[id]
}

/** 拼出 /chat/completions 地址；baseUrl 允许被用户覆盖 */
export function chatEndpoint(spec: ProviderSpec, baseUrl = spec.baseUrl): string {
  return `${baseUrl.replace(/\/+$/, '')}${spec.paths.chat}`
}

/** 拼出 /models 地址 */
export function modelsEndpoint(spec: ProviderSpec, baseUrl = spec.baseUrl): string {
  return `${baseUrl.replace(/\/+$/, '')}${spec.paths.models}`
}
