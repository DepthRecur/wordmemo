/**
 * 供应商的声明式描述。
 *
 * 只放"数据"，不放请求逻辑——请求在 transport.ts 里统一处理。
 * 加一家供应商 = 在这里加一条，不需要改 transport。
 */
export type ProviderId = 'deepseek' | 'openai' | 'gemini' | 'glm'

export interface ReasoningCompat {
  /** thinking: `{ thinking: { type } }`；effort: `reasoning_effort: low|high` */
  style: 'thinking' | 'effort'
  field: string
}

export interface ProviderSpec {
  id: ProviderId
  label: string
  baseUrl: string
  paths: { chat: string; models: string }
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
    paths: { chat: '/chat/completions', models: '/models' },
    capabilities: { vision: true },
    compat: {
      maxTokensField: 'max_tokens',
      temperature: true,
      jsonMode: 'force',
      reasoning: { style: 'thinking', field: 'thinking' },
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
