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
