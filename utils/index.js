import { LocalStorage } from '@zos/storage'

// App and Page each held their own LocalStorage instance and did not see each other's writes
// (a snooze cleared by the page stayed "pending" in the App). A fresh instance per call always reads current data.
export const storage = {
  getItem: key => new LocalStorage().getItem(key),
  setItem: (key, value) => new LocalStorage().setItem(key, value),
  removeItem: key => new LocalStorage().removeItem(key)
}

export function assets(type) {
  return (path) => type + "/" + path;
}

export const DEFAULT_WINDOW_MIN = 25
export const MIN_WINDOW_MIN = 5
export const MAX_WINDOW_MIN = 60

// Reads the saved smart window length (minutes before the target when checks start)
export function readWindowMin(localStorage) {
  const saved = localStorage.getItem('smart_wake_window_min')
  const value = saved !== undefined && saved !== null ? Number(saved) : DEFAULT_WINDOW_MIN
  if (Number.isNaN(value)) return DEFAULT_WINDOW_MIN
  return Math.min(MAX_WINDOW_MIN, Math.max(MIN_WINDOW_MIN, value))
}

// Returns the next wake target whose check window has not started yet.
export function getNextWakeWindow(hour, minute, now = new Date(), windowMin = DEFAULT_WINDOW_MIN) {
  const windowMs = windowMin * 60 * 1000
  const target = new Date(now.getTime())
  target.setHours(hour, minute, 0, 0)
  let windowStart = new Date(target.getTime() - windowMs)

  while (windowStart.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
    windowStart = new Date(target.getTime() - windowMs)
  }

  return { target, windowStart, hardLimit: new Date(target.getTime()) }
}

// --- Persistent event log (survives app restarts; printed when the page opens) ---
const EVENT_LOG_KEY = 'smart_wake_event_log'
// As many lines as storage reliably holds; trimmed further if a write fails
const EVENT_LOG_MAX = 1000

function pad(n, len = 2) {
  return String(n).padStart(len, '0')
}

const EVENT_LOG_BACKUP_KEY = 'smart_wake_event_log_backup'

// Returns { log, raw } where raw is set only when stored text exists but could not be read as a log
function parseEventLog(raw) {
  if (raw === undefined || raw === null || raw === '') return { log: [] }
  if (Array.isArray(raw)) return { log: raw }
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return { log: parsed }
  } catch (e) {
    // fall through: unreadable
  }
  return { log: null, raw: String(raw) }
}

function readEventLog(localStorage) {
  return parseEventLog(localStorage.getItem(EVENT_LOG_KEY)).log || []
}

// Reads the log for appending. A read that lands mid-write by another process (the background service
// and the page both log) is retried; if still unreadable the raw text is kept as a backup, never discarded.
function readEventLogForAppend(localStorage, stamp) {
  let result = parseEventLog(localStorage.getItem(EVENT_LOG_KEY))
  if (result.log) return result.log
  result = parseEventLog(localStorage.getItem(EVENT_LOG_KEY))
  if (result.log) return result.log
  const previous = localStorage.getItem(EVENT_LOG_BACKUP_KEY)
  localStorage.setItem(EVENT_LOG_BACKUP_KEY, `${previous ? `${previous}
` : ''}[${stamp}] ${result.raw}`)
  return [`${stamp} previous log unreadable (${result.raw.length} chars); saved to backup`]
}

// Appends one timestamped line, keeping only the newest EVENT_LOG_MAX lines
export function logEvent(localStorage, message) {
  try {
    const d = new Date()
    const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const log = readEventLogForAppend(localStorage, stamp)
    log.push(`${stamp} ${message}`)
    if (log.length > EVENT_LOG_MAX) log.splice(0, log.length - EVENT_LOG_MAX)
    try {
      localStorage.setItem(EVENT_LOG_KEY, JSON.stringify(log))
    } catch (writeErr) {
      // Storage full: keep halving (newest lines kept) until the write succeeds
      let kept = log
      while (kept.length > 1) {
        kept = kept.slice(Math.floor(kept.length / 2))
        const trimmed = kept.concat(`${stamp} log trimmed to ${kept.length} lines after write failure`)
        try {
          localStorage.setItem(EVENT_LOG_KEY, JSON.stringify(trimmed))
          return
        } catch (retryErr) {
          // still too large, halve again
        }
      }
      throw writeErr
    }
  } catch (e) {
    console.log('[SMART_WAKE_EVENT] logEvent failed:', e)
  }
}

// The phone's log viewer drops lines sent in a burst (79 stored entries arrived as ~13),
// so entries go out a few per line, paced, with numbered parts to make any gap visible.
const DUMP_ENTRIES_PER_LINE = 8
const DUMP_INTERVAL_MS = 120

// Returns a function that stops the paced dump (call it when the page is destroyed)
export function dumpEventLog(localStorage) {
  const log = readEventLog(localStorage)
  const parts = []
  for (let i = 0; i < log.length; i += DUMP_ENTRIES_PER_LINE) {
    parts.push(log.slice(i, i + DUMP_ENTRIES_PER_LINE))
  }
  const backup = localStorage.getItem(EVENT_LOG_BACKUP_KEY)
  if (backup) {
    // Raw text of any log that could not be read, in chunks the viewer can show
    const text = String(backup)
    for (let i = 0; i < text.length; i += 600) parts.push([`BACKUP ${text.slice(i, i + 600)}`])
  }
  console.log(`[SMART_WAKE_EVENT] ===== Stored event log: ${log.length} entries in ${parts.length} parts, oldest first =====`)

  let index = 0
  let timer = null
  const sendNext = () => {
    if (index >= parts.length) {
      console.log(`[SMART_WAKE_EVENT] ===== End of stored event log (${parts.length} parts sent) =====`)
      timer = null
      return
    }
    console.log(`[SMART_WAKE_EVENT] part ${index + 1}/${parts.length} | ${parts[index].join(' | ')}`)
    index++
    timer = setTimeout(sendNext, DUMP_INTERVAL_MS)
  }
  timer = setTimeout(sendNext, DUMP_INTERVAL_MS)

  return () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
}

// YYYY-MM-DD HH:MM:SS; the watch's toLocaleString() mangles hours (11:23 AM printed as "-1:23:11 AM")
export function formatDateTime(dateOrMs) {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(Number(dateOrMs))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// HH:MM:SS for event log messages
export function formatTimeOfDay(ms) {
  const d = new Date(Number(ms))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Same [SMART_WAKE_TRACE hh:mm:ss.ms] prefix the App and Page use
export function trace(message) {
  const d = new Date()
  console.log(`[SMART_WAKE_TRACE ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${d.getMilliseconds()}] ${message}`)
}

export const DEFAULT_SNOOZE_MIN = 10
export const MIN_SNOOZE_MIN = 1
export const MAX_SNOOZE_MIN = 30

// Reads the saved snooze length in minutes
export function readSnoozeMin(localStorage) {
  const saved = localStorage.getItem('smart_wake_snooze_min')
  const value = saved !== undefined && saved !== null ? Number(saved) : DEFAULT_SNOOZE_MIN
  if (Number.isNaN(value)) return DEFAULT_SNOOZE_MIN
  return Math.min(MAX_SNOOZE_MIN, Math.max(MIN_SNOOZE_MIN, value))
}


export const DEFAULT_CHECK_MIN = 5
export const MIN_CHECK_MIN = 1
export const MAX_CHECK_MIN = 15

// Reads the saved interval between sleep checks in minutes
export function readCheckMin(localStorage) {
  const saved = localStorage.getItem('smart_wake_check_min')
  const value = saved !== undefined && saved !== null ? Number(saved) : DEFAULT_CHECK_MIN
  if (Number.isNaN(value)) return DEFAULT_CHECK_MIN
  return Math.min(MAX_CHECK_MIN, Math.max(MIN_CHECK_MIN, value))
}
