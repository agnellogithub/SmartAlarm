import * as zosAlarm from '@zos/alarm'
import { getNextWakeWindow, readWindowMin, readSnoozeMin, logEvent, formatTimeOfDay, formatDateTime, trace } from './index'

// Shared by the page and the background service

export const ALARM_PAGE_URL = 'page/gt/home/index.page'
// Alarms start the background service: alarms that opened the page directly fired but never opened it
// once the watch had been idle (14:35 test, two mornings); the service started on time after 60 min idle.
export const SERVICE_URL = 'app-service/index'
export const WAKE_CHECK_PARAM = 'wake-check'
// Snooze is only offered for a ring within this long
export const SNOOZE_MAX_AGE_MS = 30 * 60 * 1000

// IDs of this app's alarms the system still holds, or null if the API isn't available
function getPendingAlarmIds() {
  try {
    if (typeof zosAlarm.getAllAlarms !== 'function') return null
    const ids = zosAlarm.getAllAlarms()
    return Array.isArray(ids) ? ids.map(Number) : null
  } catch (e) {
    trace(`getAllAlarms exception: ${e && e.message ? e.message : e}`)
    return null
  }
}

// Logs whether the alarm we expect is still registered with the system
export function checkPendingAlarm(localStorage, context) {
  const expectedId = Number(localStorage.getItem('smart_wake_alarm_id'))
  const dueMs = Number(localStorage.getItem('smart_wake_next_alarm_ms'))
  const pending = getPendingAlarmIds()
  const present = pending === null ? 'unknown' : (expectedId && pending.includes(expectedId) ? 'yes' : 'NO')
  logEvent(localStorage, `${context}: expect alarm ${expectedId || 'none'} due ${dueMs ? formatDateTime(new Date(dueMs)) : 'n/a'}, pending=${present}, system alarms=${pending === null ? 'n/a' : JSON.stringify(pending)}`)
}

// Sets the one alarm this app relies on. store: true keeps it across a watch restart.
export function placeAlarm(localStorage, timeMs, reason) {
  const timeSec = Math.floor(timeMs / 1000)
  const alarmId = zosAlarm.set({
    url: SERVICE_URL,
    time: timeSec,
    store: true,
    param: WAKE_CHECK_PARAM
  })
  localStorage.setItem('smart_wake_alarm_id', String(alarmId))
  localStorage.setItem('smart_wake_next_alarm_ms', String(timeSec * 1000))
  checkPendingAlarm(localStorage, `alarm set (${reason})`)
  return alarmId
}

// Trial: an alarm that starts the background service instead of the page (does not touch the wake alarm)
// --- Buzz chain ---
// The service is stopped as soon as onInit returns (even with the watch's background setting on), so it
// buzzes only once per start. A ring is therefore a chain of short alarms, each starting the service
// for one buzz and setting the next, until Snooze/Dismiss or the limit.
export const BUZZ_INTERVAL_SEC = 15
export const RING_BUZZ_MAX = 20
export const TEST_BUZZ_MAX = 5
export const RING_REPEAT_PARAM = 'ring-repeat'
export const TEST_REPEAT_PARAM = 'test-repeat'
// Chain progress lives in its own key: the service writes it while the page may be writing the event log
const BUZZ_CHAIN_KEY = 'smart_wake_buzz_chain'

export function readBuzzChain(localStorage) {
  try {
    const raw = localStorage.getItem(BUZZ_CHAIN_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

// Records one buzz and, unless the chain is done, sets the alarm for the next one
export function continueBuzzChain(localStorage, kind, count, max) {
  const chain = { kind, count, lastMs: Date.now(), max, alarmId: null, ended: count >= max }
  if (!chain.ended) {
    const timeSec = Math.floor(Date.now() / 1000) + BUZZ_INTERVAL_SEC
    chain.alarmId = zosAlarm.set({
      url: SERVICE_URL,
      time: timeSec,
      store: true,
      param: kind === 'ring' ? RING_REPEAT_PARAM : TEST_REPEAT_PARAM
    })
  }
  localStorage.setItem(BUZZ_CHAIN_KEY, JSON.stringify(chain))
  return chain
}

export function endBuzzChain(localStorage, reason) {
  const chain = readBuzzChain(localStorage)
  if (!chain || chain.ended) return
  if (chain.alarmId) {
    try {
      zosAlarm.cancel(Number(chain.alarmId))
    } catch (e) {
      trace(`cancel buzz alarm failed: ${e && e.message ? e.message : e}`)
    }
  }
  chain.ended = true
  chain.endReason = reason
  localStorage.setItem(BUZZ_CHAIN_KEY, JSON.stringify(chain))
}

export function placeServiceTestAlarm(localStorage, minutesAhead) {
  const oldId = Number(localStorage.getItem('smart_wake_test_alarm_id'))
  if (oldId) {
    try { zosAlarm.cancel(oldId) } catch (e) { trace(`cancel old test alarm failed: ${e && e.message ? e.message : e}`) }
  }
  const dueMs = (Math.floor(Date.now() / 1000) + minutesAhead * 60) * 1000
  const alarmId = zosAlarm.set({ url: SERVICE_URL, time: dueMs / 1000, store: true, param: 'service-test' })
  localStorage.setItem('smart_wake_test_alarm_id', String(alarmId))
  localStorage.setItem('smart_wake_test_due_ms', String(dueMs))
  const pending = getPendingAlarmIds()
  logEvent(localStorage, `service test alarm ${alarmId} set for ${formatDateTime(dueMs)} (+${minutesAhead} min), pending=${pending === null ? 'unknown' : (pending.includes(Number(alarmId)) ? 'yes' : 'NO')}`)
  return dueMs
}

export function cancelExistingAlarm(localStorage) {
  trace('ENTER: cancelExistingAlarm()')
  try {
    const activeAlarmId = localStorage.getItem('smart_wake_alarm_id')
    trace(`Reading active alarm ID from LocalStorage: ${activeAlarmId}`)
    if (activeAlarmId) {
      zosAlarm.cancel(Number(activeAlarmId))
      localStorage.removeItem('smart_wake_alarm_id')
      trace(`Alarm ID ${activeAlarmId} successfully cancelled and removed from storage.`)
    } else {
      trace('No active alarm ID found in storage. Nothing to cancel.')
    }
  } catch (e) {
    trace(`Cancel alarm exception: ${e && e.message ? e.message : e}`)
  }
  trace('EXIT: cancelExistingAlarm()')
}

export function scheduleNextDayAlarm(localStorage) {
  trace('ENTER: scheduleNextDayAlarm()')
  try {
    // Default only when unset, so a saved midnight hour (0) is kept
    const savedHour = localStorage.getItem('smart_wake_hour')
    const savedMin = localStorage.getItem('smart_wake_minute')
    const targetHour = savedHour !== undefined && savedHour !== null ? Number(savedHour) : 7
    const targetMin = savedMin !== undefined && savedMin !== null ? Number(savedMin) : 0

    trace(`Target config loaded -> Hour: ${targetHour}, Minute: ${targetMin}`)

    // Next occurrence whose window has not started (avoids skipping a day when dismissed the evening before)
    const now = new Date()
    const { target, windowStart, hardLimit } = getNextWakeWindow(targetHour, targetMin, now, readWindowMin(localStorage))

    localStorage.setItem('smart_wake_target_ms', String(target.getTime()))
    localStorage.setItem('smart_wake_start_ms', String(windowStart.getTime()))
    localStorage.setItem('smart_wake_hard_limit_ms', String(hardLimit.getTime()))
    localStorage.removeItem('smart_wake_snooze_until_ms')

    cancelExistingAlarm(localStorage)

    const alarmId = placeAlarm(localStorage, windowStart.getTime(), 'next day window start')

    trace(`=== NEXT DAY ROLLOVER SUCCESS === Checks Start: ${formatDateTime(windowStart)} (Alarm ID: ${alarmId}), Target Hard Limit: ${formatDateTime(hardLimit)}`)
    logEvent(localStorage, `next day scheduled: checks ${formatDateTime(windowStart)}, target ${formatTimeOfDay(hardLimit.getTime())} (alarm id ${alarmId})`)
  } catch (e) {
    trace(`Reschedule next day exception: ${e && e.message ? e.message : e}`)
    logEvent(localStorage, `next day schedule error: ${e && e.message ? e.message : e}`)
  }
  trace('EXIT: scheduleNextDayAlarm()')
}

// Remembers the ring so snoozeAlarm() can restore today's window after the next-day rollover
export function recordRing(localStorage, hardLimitMs) {
  trace(`recordRing() | Hard Limit: ${hardLimitMs ? formatDateTime(new Date(hardLimitMs)) : 'N/A'}`)
  localStorage.setItem('smart_wake_rang_at_ms', String(Date.now()))
  localStorage.setItem('smart_wake_rang_hard_limit_ms', String(hardLimitMs || Date.now()))
}

// True while a ring has not been snoozed or dismissed; the vibration loop polls this to stop itself
export function isRingPending(localStorage) {
  const rangAtMs = Number(localStorage.getItem('smart_wake_rang_at_ms'))
  return !!rangAtMs && Date.now() - rangAtMs <= SNOOZE_MAX_AGE_MS
}

// Returns the snooze end time in ms, or 0 if there is no recent ring to snooze
export function snoozeAlarm(localStorage) {
  trace('ENTER: snoozeAlarm()')
  let snoozeUntilMs = 0
  try {
    const nowMs = Date.now()
    const rangAtMs = Number(localStorage.getItem('smart_wake_rang_at_ms'))
    const rangHardLimitMs = Number(localStorage.getItem('smart_wake_rang_hard_limit_ms'))

    trace(`Snooze Check -> Rang At: ${rangAtMs ? formatDateTime(new Date(rangAtMs)) : 'N/A'}, Rang Hard Limit: ${rangHardLimitMs ? formatDateTime(new Date(rangHardLimitMs)) : 'N/A'}`)

    if (!isRingPending(localStorage)) {
      trace('No recent ring found. Nothing to snooze.')
      logEvent(localStorage, 'snooze ignored: no recent ring')
      trace('EXIT: snoozeAlarm()')
      return 0
    }

    // Whole seconds, so the alarm (second precision) can't fire just before the hard limit
    const snoozeMs = readSnoozeMin(localStorage) * 60 * 1000
    snoozeUntilMs = Math.ceil((nowMs + snoozeMs) / 1000) * 1000
    // If the snooze runs past the hard limit, push the hard limit out to the snooze end too
    const newHardLimitMs = rangHardLimitMs && rangHardLimitMs > snoozeUntilMs ? rangHardLimitMs : snoozeUntilMs

    // Restore today's window (scheduleNextDayAlarm() already moved it to tomorrow)
    localStorage.setItem('smart_wake_start_ms', String(nowMs))
    localStorage.setItem('smart_wake_hard_limit_ms', String(newHardLimitMs))
    localStorage.setItem('smart_wake_target_ms', String(newHardLimitMs))
    localStorage.setItem('smart_wake_snooze_until_ms', String(snoozeUntilMs))

    cancelExistingAlarm(localStorage)

    const alarmId = placeAlarm(localStorage, snoozeUntilMs, 'snooze')
    // Clearing the pending ring also stops any buzz alarm that still fires
    localStorage.removeItem('smart_wake_rang_at_ms')
    endBuzzChain(localStorage, 'snooze')

    trace(`Snoozed -> Next Check: ${formatDateTime(new Date(snoozeUntilMs))} (Alarm ID: ${alarmId}), Hard Limit: ${formatDateTime(new Date(newHardLimitMs))}`)
    logEvent(localStorage, `snoozed until ${formatTimeOfDay(snoozeUntilMs)}, hard limit ${formatTimeOfDay(newHardLimitMs)} (alarm id ${alarmId})`)
  } catch (e) {
    trace(`Snooze exception: ${e && e.message ? e.message : e}`)
    logEvent(localStorage, `snooze error: ${e && e.message ? e.message : e}`)
    snoozeUntilMs = 0
  }
  trace('EXIT: snoozeAlarm()')
  return snoozeUntilMs
}
