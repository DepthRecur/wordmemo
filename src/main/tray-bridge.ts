/**
 * 主进程内部的「刷新托盘」通知。
 *
 * 托盘计数跟当前库走（PLAN-DECKS §7），但刷新托盘要拿 Tray 实例，那是 index.ts 的局部变量。
 * 用一个小小的回调注册表把两边解开，避免 ipc.ts ↔ index.ts 互相 import。
 */
let refresher: (() => void) | null = null

export function setTrayRefresher(fn: (() => void) | null): void {
  refresher = fn
}

export function requestTrayRefresh(): void {
  try {
    refresher?.()
  } catch {
    /* 托盘还没建好 / 已销毁：下次定时刷新会补上 */
  }
}
