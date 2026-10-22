import { Sleep, HeartRate } from '@zos/sensor'
import { logEvent, formatTimeOfDay, formatDateTime, readCheckMin, trace } from './index'
import { cancelExistingAlarm, scheduleNextDayAlarm, recordRing, placeAlarm } from './alarm'

// One wake check, run by the background service each time a wake alarm fires.
// Decides whether to ring now or schedule the next check; the caller handles the ring itself
// (notification, opening the ring screen), since only the page can keep vibrating.

const SLEEP_RECORD_MAX_AGE_MIN = 15
const HARD_LIMIT_TOLERANCE_MS = 5 * 1000
const MIN_ALARM_LEAD_MS = 30 * 1000

function errText(e) {
  return e && e.message ? e.message : String(e)
}

// Diagnostic, one line per check: does anything change live while asleep?
function probeLiveSignals(localStorage, sleep) {
  const parts = []
  const read = (label, fn) => {
    try {
      parts.push(`${label}=${fn()}`)
    } catch (e) {
      parts.push(`${label}=ERR(${errText(e)})`)
    }
  }
  read('sleeping', () => sleep.getSleepingStatus())
  read('stages', () => {
    const stages = sleep.getStage() || []
    const last = stages[stages.length - 1]
    return last ? `${stages.length} last=${last.model}@${last.start}-${last.stop}` : '0'
  })
  read('info', () => {
    const info = sleep.getInfo() || {}
    return `${info.startTime}-${info.endTime}`
  })
  try {
    const hr = new HeartRate()
    read('hrLast', () => hr.getLast())
    read('hrToday', () => {
      const today = hr.getToday() || []
      return `${today.length}:[${today.slice(-5).join(',')}]`
    })
  } catch (e) {
    parts.push(`hr=ERR(${errText(e)})`)
  }
  logEvent(localStorage, `probe: ${parts.join(' ')}`)
}

// Returns { stageName, isOptimal } from the latest sleep record
function readSleepStage(localStorage, nowMs) {
  try {
    const sleep = new Sleep()
    sleep.updateInfo()
    const stages = sleep.getStage()
    const constants = sleep.getStageConstantObj()
    probeLiveSignals(localStorage, sleep)

    if (!stages || !Array.isArray(stages) || stages.length === 0) {
      // No live data: keep checking; the hard limit still guarantees the wake-up
      return { stageName: 'No Data', isOptimal: false }
    }

    const lastEntry = stages[stages.length - 1]
    const names = {
      [constants.LIGHT_STAGE]: ['Light Sleep', true],
      [constants.WAKE_STAGE]: ['Awake', true],
      [constants.DEEP_STAGE]: ['Deep Sleep', false],
      [constants.REM_STAGE]: ['REM Sleep', false]
    }
    let [stageName, isOptimal] = names[lastEntry.model] || [`Code ${lastEntry.model}`, false]

    // Stage start/stop are minutes from 00:00 of the previous day (e.g. 1945 = 08:25 today, verified on device);
    // % 1440 gives the time of day. Ignore records that ended too long ago (e.g. last night's session)
    const nowDate = new Date(nowMs)
    const nowMinOfDay = nowDate.getHours() * 60 + nowDate.getMinutes()
    const stopMinOfDay = Number(lastEntry.stop) % 1440
    const ageMin = (nowMinOfDay - stopMinOfDay + 1440) % 1440
    if (isOptimal && (Number.isNaN(stopMinOfDay) || ageMin > SLEEP_RECORD_MAX_AGE_MIN)) {
      stageName = `${stageName} (stale, ${ageMin} min old)`
      isOptimal = false
    }
    return { stageName, isOptimal }
  } catch (e) {
    logEvent(localStorage, `sleep sensor error: ${errText(e)}`)
    return { stageName: `Sensor Error: ${errText(e)}`, isOptimal: false }
  }
}

// Returns { ring: true, reason } when it is time to wake, otherwise { ring: false }
export function runWakeCheck(localStorage) {
  trace('ENTER: runWakeCheck()')
  try {
    const nowMs = Date.now()
    const dueMs = Number(localStorage.getItem('smart_wake_next_alarm_ms'))
    const hardLimitMs = Number(localStorage.getItem('smart_wake_hard_limit_ms'))
    const lateSec = dueMs ? Math.round((nowMs - dueMs) / 1000) : null
    logEvent(localStorage, `check start: due ${dueMs ? formatTimeOfDay(dueMs) : 'n/a'}, ${lateSec === null ? 'no scheduled alarm' : `${lateSec}s late`}, target ${hardLimitMs ? formatTimeOfDay(hardLimitMs) : 'n/a'}`)

    if (String(localStorage.getItem('smart_wake_enabled')) !== 'true') {
      logEvent(localStorage, 'check aborted: alarm disabled')
      return { ring: false }
    }
    if (!hardLimitMs) {
      logEvent(localStorage, 'check aborted: no wake window stored')
      return { ring: false }
    }

    // Tolerance: the alarm may fire a moment before the exact hard limit
    if (nowMs >= hardLimitMs - HARD_LIMIT_TOLERANCE_MS) {
      const reason = `wake time ${formatTimeOfDay(hardLimitMs)} reached`
      logEvent(localStorage, `RING: ${reason}`)
      recordRing(localStorage, hardLimitMs)
      scheduleNextDayAlarm(localStorage)
      return { ring: true, reason }
    }

    const { stageName, isOptimal } = readSleepStage(localStorage, nowMs)
    logEvent(localStorage, `stage: ${stageName}, optimal=${isOptimal}`)

    if (isOptimal) {
      const reason = `optimal stage (${stageName})`
      logEvent(localStorage, `RING: ${reason}`)
      recordRing(localStorage, hardLimitMs)
      scheduleNextDayAlarm(localStorage)
      return { ring: true, reason }
    }

    const checkMin = readCheckMin(localStorage)
    const nextCheckMs = nowMs + checkMin * 60 * 1000
    const cappedMs = hardLimitMs < nextCheckMs ? hardLimitMs : nextCheckMs
    // Never schedule closer than the minimum lead, or the alarm can land in the past and never fire
    const targetTimeMs = Math.max(cappedMs, nowMs + MIN_ALARM_LEAD_MS)
    cancelExistingAlarm(localStorage)
    const alarmId = placeAlarm(localStorage, targetTimeMs, 'next check')
    logEvent(localStorage, `next check set for ${formatTimeOfDay(targetTimeMs)} (alarm id ${alarmId})`)
    trace(`Next check at ${formatDateTime(targetTimeMs)}`)
    return { ring: false }
  } catch (e) {
    logEvent(localStorage, `FATAL in wake check: ${errText(e)}`)
    return { ring: false }
  } finally {
    trace('EXIT: runWakeCheck()')
  }
}
