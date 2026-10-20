import { set, cancel } from '@zos/alarm'
import { getNextWakeWindow, readWindowMin, readSnoozeMin, logEvent, formatTimeOfDay, trace } from './index'

// Shared by App and Page so the page never depends on reaching App methods through getApp()

export const ALARM_PAGE_URL = 'page/gt/home/index.page'
// Snooze is only offered for a ring within this long
export const SNOOZE_MAX_AGE_MS = 30 * 60 * 1000

export function cancelExistingAlarm(localStorage) {
  trace('ENTER: cancelExistingAlarm()')
  try {
    const activeAlarmId = localStorage.getItem('smart_wake_alarm_id')
    trace(`Reading active alarm ID from LocalStorage: ${activeAlarmId}`)
    if (activeAlarmId) {
      cancel(Number(activeAlarmId))
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

    const alarmId = set({
      url: ALARM_PAGE_URL,
      time: Math.floor(windowStart.getTime() / 1000)
    })

    localStorage.setItem('smart_wake_alarm_id', String(alarmId))
    localStorage.setItem('smart_wake_next_alarm_ms', String(windowStart.getTime()))

    trace(`=== NEXT DAY ROLLOVER SUCCESS === Checks Start: ${windowStart.toLocaleString()} (Alarm ID: ${alarmId}), Target Hard Limit: ${hardLimit.toLocaleString()}`)
    logEvent(localStorage, `next day scheduled: checks ${windowStart.toLocaleString()}, target ${formatTimeOfDay(hardLimit.getTime())} (alarm id ${alarmId})`)
  } catch (e) {
    trace(`Reschedule next day exception: ${e && e.message ? e.message : e}`)
    logEvent(localStorage, `next day schedule error: ${e && e.message ? e.message : e}`)
  }
  trace('EXIT: scheduleNextDayAlarm()')
}

// Remembers the ring so snoozeAlarm() can restore today's window after the next-day rollover
export function recordRing(localStorage, hardLimitMs) {
  trace(`recordRing() | Hard Limit: ${hardLimitMs ? new Date(hardLimitMs).toLocaleString() : 'N/A'}`)
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

    trace(`Snooze Check -> Rang At: ${rangAtMs ? new Date(rangAtMs).toLocaleString() : 'N/A'}, Rang Hard Limit: ${rangHardLimitMs ? new Date(rangHardLimitMs).toLocaleString() : 'N/A'}`)

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

    const alarmId = set({
      url: ALARM_PAGE_URL,
      time: Math.floor(snoozeUntilMs / 1000)
    })

    localStorage.setItem('smart_wake_alarm_id', String(alarmId))
    localStorage.setItem('smart_wake_next_alarm_ms', String(snoozeUntilMs))
    // Clearing the pending ring also stops the App's vibration loop
    localStorage.removeItem('smart_wake_rang_at_ms')

    trace(`Snoozed -> Next Check: ${new Date(snoozeUntilMs).toLocaleString()} (Alarm ID: ${alarmId}), Hard Limit: ${new Date(newHardLimitMs).toLocaleString()}`)
    logEvent(localStorage, `snoozed until ${formatTimeOfDay(snoozeUntilMs)}, hard limit ${formatTimeOfDay(newHardLimitMs)} (alarm id ${alarmId})`)
  } catch (e) {
    trace(`Snooze exception: ${e && e.message ? e.message : e}`)
    logEvent(localStorage, `snooze error: ${e && e.message ? e.message : e}`)
    snoozeUntilMs = 0
  }
  trace('EXIT: snoozeAlarm()')
  return snoozeUntilMs
}
