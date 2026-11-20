import type { Settings, SettingsPatch } from '@shared/types'

/**
 * 设置页「改完就保存」写盘的范围（P-05）。
 *
 * 只包含这一页拥有字段：当前库（别的页面/托盘会改）、派生标记（主进程算的）
 * 都不在这里，自动保存才不会把它们覆盖掉。
 */
export function ownedPatch(s: Settings): SettingsPatch {
  return {
    model: s.model,
    baseUrl: s.baseUrl,
    ai: s.ai,
    longTermRetention: s.longTermRetention,
    examRetention: s.examRetention,
    newPerDay: s.newPerDay,
    dailyMinutes: s.dailyMinutes,
    learnAheadMinutes: s.learnAheadMinutes,
    listenCardEnabled: s.listenCardEnabled,
    autoPlayAudio: s.autoPlayAudio,
    accent: s.accent,
    aiJudge: s.aiJudge,
    aiValidate: s.aiValidate,
    monthlyBudgetUsd: s.monthlyBudgetUsd,
    reminders: s.reminders,
    remindEnabled: s.remindEnabled,
    autoLaunch: s.autoLaunch,
    quietHours: s.quietHours,
    ttsSources: s.ttsSources
  }
}
