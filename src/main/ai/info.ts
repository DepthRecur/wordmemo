/**
 * 设置页要的供应商只读视图（不含 Key）。
 *
 * 放在单独文件里是为了避开循环依赖：catalog.ts 依赖 client.ts 的端点解析，
 * client.ts 不该反过来依赖 catalog.ts。
 */
import type { AiProviderInfo, AiSettingsInfo } from '@shared/types'
import { getApiKey } from '../settings'
import { monthAiCost } from '../db/ai'
import { PROVIDERS, PROVIDER_IDS } from './providers'
import { providerBaseUrl, providerModel } from './client'
import { cachedCatalog } from './catalog'
import { priceFor, snapshotInfo } from './pricing'

export function aiSettingsInfo(): AiSettingsInfo {
  const providers: AiProviderInfo[] = PROVIDER_IDS.map((id) => {
    const spec = PROVIDERS[id]
    const model = providerModel(id)
    const catalog = cachedCatalog(id)
    return {
      id,
      label: spec.label,
      baseUrl: providerBaseUrl(id),
      model,
      keySet: !!getApiKey(id),
      vision: spec.capabilities.vision,
      unverified: !!spec.unverified,
      models: catalog.models.map((m) => m.id),
      modelsFetchedAt: catalog.fetchedAt,
      stale: catalog.stale,
      catalogError: catalog.error,
      price: priceFor(id, model)
    }
  })
  return { providers, pricing: snapshotInfo(), usage: monthAiCost() }
}
