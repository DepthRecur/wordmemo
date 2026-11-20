import type { AiProviderId, AiRoleConfig, AiSettings } from './types'

/** DeepSeek 没有配模型时的兜底名（价格与目录都在 pricing.ts，这里只有名字） */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'

/**
 * 某一家实际会用的模型名（角色覆盖 > 卡片配置 > DeepSeek 旧字段/默认）。
 *
 * 主进程（发请求）和设置页（按钮可用性）必须用同一套判断，所以放在 shared。
 */
export function resolveProviderModel(
  ai: AiSettings,
  id: AiProviderId,
  role?: AiRoleConfig,
  legacyModel?: string
): string {
  const fromRole = role && role.provider === id ? role.model?.trim() : ''
  if (fromRole) return fromRole
  const own = ai.providers[id]?.model?.trim()
  if (own) return own
  if (id === 'deepseek') return legacyModel?.trim() || DEEPSEEK_DEFAULT_MODEL
  return ''
}
