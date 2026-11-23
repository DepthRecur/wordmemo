/**
 * 同步格式的公共常量（主进程与渲染进程都会用到；不依赖任何数据库/Node 模块）。
 *
 * `formatVersion` 是**协议版本**：远端 `meta.json`、每个分片的密文头、本地
 * `sync_state.format_version` 都用它。读到更大的一律拒绝，绝不半懂半不懂地合并
 * （PLAN-SYNC §4）。
 */
export const SYNC_FORMAT_VERSION = 1

/** 同步文件（`.wmsync` 与远端分片）的类型 */
export type SyncFileKind = 'checkpoint' | 'wmsync' | 'ops' | 'meta' | 'info'

export interface SyncErrorInfo {
  code:
    | 'pat_invalid'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'rate_limited'
    | 'server_error'
    | 'network'
    | 'timeout'
    | 'not_private'
    | 'format_too_new'
    | 'bad_file'
    | 'bad_passphrase'
    | 'unknown'
  message: string
  status?: number
}
