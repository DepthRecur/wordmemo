/**
 * 设置页要的供应商只读视图（不含 Key）。
 *
 * 放在单独文件里是为了避开循环依赖：catalog.ts 依赖 client.ts 的端点解析，
 * client.ts 不该反过来依赖 catalog.ts。
 */
import type { AiModelInfo, AiProviderInfo, AiSettingsInfo } from '@shared/types'
import { getApiKey } from '../settings'
import { monthAiCost } from '../db/ai'
import { PROVIDERS, PROVIDER_IDS } from './providers'
import { providerBaseUrl, providerModel } from './client'
import { cachedCatalog } from './catalog'
import { knownModels, priceFor, snapshotInfo } from './pricing'

/**
 * 模型下拉框的候选：**只来自 /models 目录**（有这个 Key 才拉得到，避免让用户
 * 看到"其实调不了"的模型）。models.dev 只用来补公开名和价格，不往列表里加模型。
 */
function modelList(provider: (typeof PROVIDER_IDS)[number]): AiModelInfo[] {
  const catalog = cachedCatalog(provider)
  const known = knownModels(provider)
  return catalog.models.map((entry) => {
    const meta = known[entry.id]
    // API 自报的名字优先（DeepSeek 会回 DeepSeek-V4.1-Flash），其次 models.dev，最后 id
    const apiName = entry.name && entry.name !== entry.id ? entry.name : ''
    const name = apiName || meta?.name || entry.id
    const price = meta?.price ?? priceFor(provider, entry.id)
    return {
      id: entry.id,
      name,
      priced: price.priced,
      input: price.priced ? price.input : null,
      output: price.priced ? price.output : null
    }
  })
}

export function aiSettingsInfo(): AiSettingsInfo {
  const providers: AiProviderInfo[] = PROVIDER_IDS.map((id) => {
    const spec = PROVIDERS[id]
    const model = providerModel(id)
    const catalog = cachedCatalog(id)
    return {
      id,
      label: spec.label,
      baseUrl: providerBaseUrl(id),
      fixedCatalogUrl: spec.modelsConfig?.url ?? null,
      model,
      keySet: !!getApiKey(id),
      vision: spec.capabilities.vision,
      unverified: !!spec.unverified,
      models: modelList(id),
      modelsFetchedAt: catalog.fetchedAt,
      stale: catalog.stale,
      catalogError: catalog.error,
      price: priceFor(id, model)
    }
  })
  return { providers, pricing: snapshotInfo(), usage: monthAiCost() }
}
