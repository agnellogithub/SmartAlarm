export function assets(type) {
  return (path) => type + "/" + path;
}

// Returns the next wake target whose -25m check window has not started yet.
export function getNextWakeWindow(hour, minute, now = new Date()) {
  const target = new Date(now.getTime())
  target.setHours(hour, minute, 0, 0)
  let windowStart = new Date(target.getTime() - 25 * 60 * 1000)

  while (windowStart.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
    windowStart = new Date(target.getTime() - 25 * 60 * 1000)
  }

  return { target, windowStart, hardLimit: new Date(target.getTime()) }
}
