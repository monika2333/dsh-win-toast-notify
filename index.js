/**
 * Windows toast notifications when a DeepSeek Harness turn finishes.
 *
 * The Host half of the `dsh-win-toast-notify` bundle: it listens to every
 * Session's `turn/end` event and raises a native Windows toast through the
 * WinRT `Windows.UI.Notifications` API (invoked via Windows PowerShell, so no
 * native dependency and no install script).
 *
 * Nothing is written to the session log — the session log stays the only
 * source of truth, and all state here is derived and in memory.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/** AppUserModelID registered by the DeepSeek Harness desktop app's Start-menu shortcut. */
const HARNESS_APP_ID = 'com.deepseek.dsh'
/** Fallback identity: the AUMID of the Windows PowerShell Start-menu shortcut. */
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** Shipped with every Windows install; toasts from an unregistered AUMID are dropped silently. */
const START_MENU_SHORTCUTS = ['DeepSeek Harness.lnk', 'DeepSeek Harness (Dev).lnk']

/** Headline per `turn/end` reason. */
const REASON_LABELS = {
  completed: '任务完成',
  blocked: '任务受阻',
  error: '任务出错',
  'max-tokens': '输出达到上限',
  interrupted: '任务被中断',
}

const DEFAULTS = {
  enabled: true,
  appId: '',
  powershell: '',
  titlePrefix: 'DeepSeek Harness',
  showSessionTitle: true,
  previewChars: 160,
  includeSubagents: false,
  sound: true,
  reasons: ['completed', 'error', 'blocked', 'max-tokens', 'interrupted'],
}

let warned = false
let cachedAppId

function report(error) {
  if (warned) return
  warned = true
  try {
    console.warn('[dsh-win-toast-notify]', error instanceof Error ? error.message : error)
  } catch {
    /* never let logging break a session */
  }
}

export function apply(ctx, config) {
  if (process.platform !== 'win32') return

  const opts = resolveOptions(config)
  if (!opts.enabled) return

  /** sessionId -> { startedAt, text } for the turn in flight. */
  const turns = new Map()

  const off = ctx.on('session/event', (session, event) => {
    try {
      track(ctx, opts, turns, session, event)
    } catch (error) {
      report(error)
    }
  })

  return () => {
    off()
    turns.clear()
  }
}

function resolveOptions(config) {
  const supplied = config && typeof config === 'object' ? config : {}
  const options = { ...DEFAULTS, ...supplied }
  const reasons = Array.isArray(options.reasons) && options.reasons.length > 0
    ? options.reasons.map((reason) => String(reason))
    : DEFAULTS.reasons
  return { ...options, reasons }
}

function track(ctx, opts, turns, session, event) {
  const type = event?.type
  if (type !== 'turn/start' && type !== 'assistant/message' && type !== 'turn/end') return

  const header = session?.header ?? {}
  if (!opts.includeSubagents && header.origin === 'subagent') return

  const sessionId = String(session?.id ?? header.id ?? '')
  if (!sessionId) return

  if (type === 'turn/start') {
    turns.set(sessionId, { startedAt: Number(event.time) || 0, text: '' })
    return
  }

  if (type === 'assistant/message') {
    const text = messageText(event.data?.message)
    if (!text) return
    const state = turns.get(sessionId) ?? { startedAt: 0, text: '' }
    state.text = text
    turns.set(sessionId, state)
    return
  }

  // turn/end
  const reason = String(event.data?.reason?.kind ?? 'completed')
  const state = turns.get(sessionId)
  turns.delete(sessionId)

  if (!opts.reasons.includes(reason)) return
  const label = REASON_LABELS[reason]
  if (!label) return

  const subject = clamp(sessionSubject(ctx, session, opts), 48)
  const preview = cleanPreview(state?.text, opts.previewChars)
  const startedAt = state?.startedAt ?? 0
  const elapsed = startedAt > 0 ? formatDuration(Number(event.time) - startedAt) : ''
  const meta = [opts.titlePrefix, elapsed ? `用时 ${elapsed}` : ''].filter(Boolean).join(' · ')

  notify({
    title: `${label} · ${subject}`,
    body: preview || (reason === 'completed' ? '本轮没有文本回复' : '查看会话了解详情'),
    meta,
    appId: opts.appId,
    sound: opts.sound,
    powershell: opts.powershell,
  })
}

function sessionSubject(ctx, session, opts) {
  if (opts.showSessionTitle) {
    try {
      const titles = ctx.get('sessionTitle')
      const snapshot = titles?.get?.(session)
      const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
      if (title) return title
    } catch (error) {
      report(error)
    }
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim()) {
    const name = basename(cwd.trim())
    if (name) return name
  }
  return opts.titlePrefix
}

function messageText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function cleanPreview(text, maxChars) {
  let value = String(text ?? '')
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/`([^`]*)`/g, '$1')
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
  value = value.replace(/[*_~]{1,3}/g, '')
  value = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  value = value.replace(/\s+/g, ' ').trim()
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULTS.previewChars
  if (value.length > limit) value = `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
  return value
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 86_400_000) return ''
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes <= 0) return `${seconds} 秒`
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}

function clamp(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Pick the AUMID to post under. `com.deepseek.dsh` only exists once the
 * desktop app wrote its Start-menu shortcut; on a plain `dsh web` or CLI
 * install the toast would be accepted and then dropped, so fall back to the
 * PowerShell identity that every Windows install registers.
 */
function resolveAppId(configured) {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  if (cachedAppId !== undefined) return cachedAppId
  cachedAppId = hasHarnessShortcut() ? HARNESS_APP_ID : POWERSHELL_APP_ID
  return cachedAppId
}

function hasHarnessShortcut() {
  const roots = []
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  if (process.env.ProgramData) roots.push(join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  for (const root of roots) {
    for (const name of START_MENU_SHORTCUTS) {
      if (existsSync(join(root, name))) return true
    }
  }
  return false
}

/**
 * Raise one Windows toast. Returns whether the notifier process was started;
 * delivery itself is asynchronous and is never awaited by the Host.
 *
 * Exported for testing and for other Host plugins that want the same channel.
 */
export function notify({ title, body = '', meta = '', appId = '', sound = true, powershell = '' } = {}) {
  if (process.platform !== 'win32') return false
  const script = buildToastScript({ title, body, meta, appId: resolveAppId(appId), sound })
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    // Not detached: the Host is long-lived, the notifier exits in about a
    // second, and a detached child can be reaped together with a job object.
    const child = spawn(resolvePowershell(powershell), [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encoded,
    ], { stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => report(error))
    return true
  } catch (error) {
    report(error)
    return false
  }
}

function resolvePowershell(configured) {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  if (existsSync(POWERSHELL_EXE)) return POWERSHELL_EXE
  return 'powershell.exe'
}

function buildToastScript({ title, body, meta, appId, sound }) {
  const lines = [title, body, meta].filter((line) => typeof line === 'string' && line.trim().length > 0)
  const texts = lines
    .map((line) => `<text>${escapeXml(clamp(line, 220))}</text>`)
    .join('')
  const audio = sound === false
    ? '<audio silent="true"/>'
    : '<audio src="ms-winsoundevent:Notification.Default"/>'
  const xml = `<toast scenario="default"><visual><binding template="ToastGeneric">${texts}</binding></visual>${audio}</toast>`
  const safeAppId = String(appId).replace(/'/g, "''")

  return [
    "$ErrorActionPreference = 'Stop'",
    `$appId = '${safeAppId}'`,
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    "$xmlString = @'",
    xml,
    "'@",
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($xmlString)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)',
    '$notifier.Show($toast)',
    '',
  ].join('\n')
}
