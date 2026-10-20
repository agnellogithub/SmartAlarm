import { Sleep, Vibrator, HeartRate } from '@zos/sensor'
import { set } from '@zos/alarm'
import { showToast } from '@zos/interaction'
import { logEvent, formatTimeOfDay, storage, readCheckMin } from './utils/index'
import { cancelExistingAlarm, scheduleNextDayAlarm, recordRing, isRingPending, snoozeAlarm } from './utils/alarm'

const localStorage = storage
const SLEEP_RECORD_MAX_AGE_MIN = 15
const HARD_LIMIT_TOLERANCE_MS = 5 * 1000
const MIN_ALARM_LEAD_MS = 30 * 1000
// Must stay below MIN_ALARM_LEAD_MS so a real follow-up check is never skipped
const EVAL_DEDUPE_MS = 10 * 1000

function getLogTime() {
  const d = new Date()
  const h = d.getHours() < 10 ? `0${d.getHours()}` : d.getHours()
  const m = d.getMinutes() < 10 ? `0${d.getMinutes()}` : d.getMinutes()
  const s = d.getSeconds() < 10 ? `0${d.getSeconds()}` : d.getSeconds()
  const ms = d.getMilliseconds()
  return `${h}:${m}:${s}.${ms}`
}

App({
  globalData: {
    vibrationTimer: null,
    vibratorInstance: null,
    isRinging: false
  },

  onCreate(options) {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.onCreate() | Options:`, JSON.stringify(options))
    this.evaluateIfDue(options)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.onCreate()`)
  },

  // Called from App.onCreate and from the page (an alarm may reopen the page without recreating the App)
  evaluateIfDue(options) {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.evaluateIfDue()`)

    // The page url is present on normal launches too, so it can't identify an alarm launch
    const isAlarmLaunch = options && (
      options.action === 'alarm' ||
      options.launchMode === 'alarm'
    )

    const startMs = Number(localStorage.getItem('smart_wake_start_ms'))
    const hardLimitMs = Number(localStorage.getItem('smart_wake_hard_limit_ms'))
    const nowMs = Date.now()

    // 5 min grace after the hard limit so a late-firing alarm still rings
    const isInAlarmWindow = startMs && hardLimitMs && (nowMs >= startMs && nowMs <= hardLimitMs + 5 * 60 * 1000)

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] onCreate Check -> isAlarmLaunch: ${isAlarmLaunch}, isInAlarmWindow: ${isInAlarmWindow}`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Window State -> Start: ${startMs ? new Date(startMs).toLocaleString() : 'N/A'}, Target/Hard Limit: ${hardLimitMs ? new Date(hardLimitMs).toLocaleString() : 'N/A'}, Current: ${new Date(nowMs).toLocaleString()}`)

    // Skip if App.onCreate and the page both ask within moments of each other
    const lastEvalMs = Number(localStorage.getItem('smart_wake_last_eval_ms'))
    const recentlyEvaluated = lastEvalMs && nowMs - lastEvalMs >= 0 && nowMs - lastEvalMs < EVAL_DEDUPE_MS

    if ((isAlarmLaunch || isInAlarmWindow) && recentlyEvaluated) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Evaluated ${nowMs - lastEvalMs} ms ago -> Skipping duplicate evaluation.`)
      logEvent(localStorage, `check skipped (duplicate, ${nowMs - lastEvalMs} ms after last)`)
    } else if (isAlarmLaunch || isInAlarmWindow) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm Context Validated -> Invoking runSmartWakeEvaluation()`)
      const dueMs = Number(localStorage.getItem('smart_wake_next_alarm_ms'))
      const lateSec = dueMs ? Math.round((nowMs - dueMs) / 1000) : null
      // Far from the scheduled time means the app was opened by hand, not by the alarm
      const onSchedule = lateSec !== null && lateSec >= -5 && lateSec <= 600
      logEvent(localStorage, `check start: due ${dueMs ? formatTimeOfDay(dueMs) : 'n/a'}, ${lateSec === null ? 'no scheduled alarm' : `${lateSec}s late`}${onSchedule ? '' : ' (opened by hand?)'}, target ${formatTimeOfDay(hardLimitMs)}`)
      localStorage.setItem('smart_wake_last_eval_ms', String(nowMs))
      this.runSmartWakeEvaluation()
    } else {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Manual UI Open Detected -> Skipping automated background evaluation.`)
    }

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.evaluateIfDue()`)
  },

  runSmartWakeEvaluation() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.runSmartWakeEvaluation()`)
    try {
      const enabledVal = localStorage.getItem('smart_wake_enabled')
      const isEnabled = String(enabledVal) === 'true' || enabledVal === true

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Reading Storage -> Enabled: ${isEnabled} (Raw: "${enabledVal}")`)

      if (!isEnabled) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Smart Wake is disabled. Aborting evaluation.`)
        logEvent(localStorage, 'check aborted: alarm disabled')
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.runSmartWakeEvaluation()`)
        return
      }

      const hardLimitMs = Number(localStorage.getItem('smart_wake_hard_limit_ms'))
      const nowMs = Date.now()

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Time Boundary Check -> Current: ${new Date(nowMs).toLocaleString()}, Target Hard Limit: ${new Date(hardLimitMs).toLocaleString()}`)

      // 1. HARD ALARM LIMIT CHECK (Target Time Reached)
      // Tolerance: the alarm may fire a moment before the exact hard limit
      if (hardLimitMs && nowMs >= hardLimitMs - HARD_LIMIT_TOLERANCE_MS) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] HARD LIMIT TRIGGERED (Target Time Reached) -> Executing alarm and rescheduling next day.`)
        logEvent(localStorage, `RING: hard limit ${formatTimeOfDay(hardLimitMs)} reached`)
        this.sendWakeAlert('Hard Target Limit Reached! Time to wake up!')
        this.recordRing(hardLimitMs)
        this.triggerAlarmVibration()
        this.scheduleNextDayAlarm()
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.runSmartWakeEvaluation()`)
        return
      }

      // 2. SLEEP STAGE EVALUATION WITH DEEP LOGGING
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Instantiating Sleep Sensor instance...`)
      let isOptimalStage = false
      let stageName = 'Unknown'

      try {
        const sleep = new Sleep()
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Sleep Sensor Instantiated. Executing sleep.updateInfo()...`)
        sleep.updateInfo()

        const stages = sleep.getStage()
        const constants = sleep.getStageConstantObj()

        this.probeLiveSignals(sleep)

        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ==================== RAW SLEEP DATA DEBUG START ====================`)
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Constants:`, JSON.stringify(constants))

        if (stages && Array.isArray(stages) && stages.length > 0) {
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Total Sleep Records Returned: ${stages.length}`)

          const lastEntry = stages[stages.length - 1]
          const lastStage = lastEntry.model
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Evaluating Active Model Entry (Last Array Item) -> Code: ${lastStage}, Raw Record:`, JSON.stringify(lastEntry))

          switch (lastStage) {
            case constants.LIGHT_STAGE:
              stageName = 'Light Sleep'
              isOptimalStage = true
              console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Match: LIGHT_STAGE -> Optimal Wake = TRUE`)
              break
            case constants.WAKE_STAGE:
              stageName = 'Awake'
              isOptimalStage = true
              console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Match: WAKE_STAGE -> Optimal Wake = TRUE`)
              break
            case constants.DEEP_STAGE:
              stageName = 'Deep Sleep'
              isOptimalStage = false
              console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Match: DEEP_STAGE -> Optimal Wake = FALSE`)
              break
            case constants.REM_STAGE:
              stageName = 'REM Sleep'
              isOptimalStage = false
              console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Match: REM_STAGE -> Optimal Wake = FALSE`)
              break
            default:
              stageName = `Code ${lastStage}`
              isOptimalStage = false
              console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Match: UNMAPPED CODE (${lastStage}) -> Optimal Wake = FALSE`)
          }

          // Stage start/stop are minutes from 00:00 of the previous day (e.g. 1945 = 08:25 today, verified on device);
          // % 1440 gives the time of day. Ignore records that ended too long ago (e.g. last night's session)
          const nowDate = new Date(nowMs)
          const nowMinOfDay = nowDate.getHours() * 60 + nowDate.getMinutes()
          const stopMinOfDay = Number(lastEntry.stop) % 1440
          const ageMin = (nowMinOfDay - stopMinOfDay + 1440) % 1440
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Record Freshness -> Stop: ${lastEntry.stop}, Age: ${ageMin} min`)

          if (isOptimalStage && (Number.isNaN(stopMinOfDay) || ageMin > SLEEP_RECORD_MAX_AGE_MIN)) {
            stageName = `${stageName} (stale, ${ageMin} min old)`
            isOptimalStage = false
            console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Last record is stale -> Optimal Wake = FALSE`)
          }
        } else {
          // No live data: keep checking; the hard limit still guarantees the wake-up
          stageName = 'No Data'
          isOptimalStage = false
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage array empty or null. Optimal Wake = FALSE`)
        }
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ==================== RAW SLEEP DATA DEBUG END ====================`)
      } catch (err) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXCEPTION in Sleep Sensor:`, err)
        logEvent(localStorage, `sleep sensor error: ${err && err.message ? err.message : err}`)
        stageName = `Sensor Error: ${err.message || err}`
        isOptimalStage = false
      }

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Evaluation Result -> Stage Name: "${stageName}", Is Optimal: ${isOptimalStage}`)
      logEvent(localStorage, `stage: ${stageName}, optimal=${isOptimalStage}`)

      if (isOptimalStage) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] OPTIMAL STAGE DETECTED -> Triggering wake alert, motor vibration, and scheduleNextDayAlarm()`)
        logEvent(localStorage, `RING: optimal stage (${stageName})`)
        this.sendWakeAlert(`Light sleep detected (${stageName})! Good morning!`)
        this.recordRing(hardLimitMs)
        this.triggerAlarmVibration()
        this.scheduleNextDayAlarm()
      } else {
        const checkMin = readCheckMin(localStorage)
        const nextCheckMs = nowMs + checkMin * 60 * 1000
        const cappedMs = hardLimitMs && hardLimitMs < nextCheckMs ? hardLimitMs : nextCheckMs
        // Never schedule closer than the minimum lead, or the alarm can land in the past and never fire
        const targetTimeMs = Math.max(cappedMs, nowMs + MIN_ALARM_LEAD_MS)

        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] NON-OPTIMAL STAGE ACTIVE (${stageName}) -> Scheduling next ${checkMin}-min check for: ${new Date(targetTimeMs).toLocaleString()}`)

        this.cancelExistingAlarm()

        const alarmId = set({
          url: 'page/gt/home/index.page',
          time: Math.floor(targetTimeMs / 1000)
        })

        localStorage.setItem('smart_wake_alarm_id', String(alarmId))
        localStorage.setItem('smart_wake_next_alarm_ms', String(Math.floor(targetTimeMs / 1000) * 1000))
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Recurring Check Alarm Set -> ID: ${alarmId}`)
        logEvent(localStorage, `next check set for ${formatTimeOfDay(targetTimeMs)} (alarm id ${alarmId})`)
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] FATAL ERROR in runSmartWakeEvaluation():`, e)
      logEvent(localStorage, `FATAL in evaluation: ${e && e.message ? e.message : e}`)
    }

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.runSmartWakeEvaluation()`)
  },

  // Diagnostic, one line per check: does anything change live while asleep?
  probeLiveSignals(sleep) {
    const parts = []
    const read = (label, fn) => {
      try {
        parts.push(`${label}=${fn()}`)
      } catch (e) {
        parts.push(`${label}=ERR(${e && e.message ? e.message : e})`)
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
      parts.push(`hr=ERR(${e && e.message ? e.message : e})`)
    }
    const line = `probe: ${parts.join(' ')}`
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ${line}`)
    logEvent(localStorage, line)
  },

  recordRing(hardLimitMs) {
    recordRing(localStorage, hardLimitMs)
  },

  // Returns the snooze end time in ms, or 0 if there is no recent ring to snooze
  snoozeAlarm() {
    this.stopVibration()
    return snoozeAlarm(localStorage)
  },

  sendWakeAlert(message) {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.sendWakeAlert() | Message: "${message}"`)
    try {
      showToast({ text: message })
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Toast displayed successfully.`)
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Toast display exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.sendWakeAlert()`)
  },

  triggerAlarmVibration() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.triggerAlarmVibration()`)
    try {
      this.stopVibration()

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Instantiating Vibrator motor...`)
      this.globalData.isRinging = true
      const vibrator = new Vibrator()
      this.globalData.vibratorInstance = vibrator
      
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Starting 30-second vibration loop (Pulse 1/6)...`)
      vibrator.start()

      let count = 0
      this.globalData.vibrationTimer = setInterval(() => {
        count++
        if (!isRingPending(localStorage)) {
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Ring was snoozed or dismissed. Invoking stopVibration()`)
          logEvent(localStorage, 'vibration stopped: ring snoozed/dismissed')
          this.stopVibration()
        } else if (count >= 6) {
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] 30-second vibration duration completed. Invoking stopVibration()`)
          logEvent(localStorage, 'vibration stopped: 30s finished')
          this.stopVibration()
        } else if (this.globalData.isRinging) {
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Vibration Interval Executing -> Pulse ${count + 1}/6`)
          vibrator.start()
        }
      }, 5000)
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Vibrator motor exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.triggerAlarmVibration()`)
  },

  stopVibration() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.stopVibration()`)
    try {
      this.globalData.isRinging = false
      if (this.globalData.vibrationTimer) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Clearing vibration interval timer.`)
        clearInterval(this.globalData.vibrationTimer)
        this.globalData.vibrationTimer = null
      }
      if (this.globalData.vibratorInstance) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stopping physical vibrator instance.`)
        this.globalData.vibratorInstance.stop()
        this.globalData.vibratorInstance = null
      }
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Vibration motor completely stopped.`)
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stop vibration exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.stopVibration()`)
  },

  cancelExistingAlarm() {
    cancelExistingAlarm(localStorage)
  },

  scheduleNextDayAlarm() {
    scheduleNextDayAlarm(localStorage)
  },

  onDestroy() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.onDestroy()`)
    this.stopVibration()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.onDestroy()`)
  }
})