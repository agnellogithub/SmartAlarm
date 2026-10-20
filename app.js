import { Sleep, Vibrator } from '@zos/sensor'
import { LocalStorage } from '@zos/storage'
import { set, cancel } from '@zos/alarm'
import { showToast } from '@zos/interaction'

const localStorage = new LocalStorage()

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

    const isAlarmLaunch = options && (
      options.action === 'alarm' || 
      options.launchMode === 'alarm' || 
      options.url === 'page/gt/home/index.page'
    )

    const startMs = Number(localStorage.getItem('smart_wake_start_ms'))
    const hardLimitMs = Number(localStorage.getItem('smart_wake_hard_limit_ms'))
    const nowMs = Date.now()

    const isInAlarmWindow = startMs && hardLimitMs && (nowMs >= startMs && nowMs <= hardLimitMs + 10000)

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] onCreate Check -> isAlarmLaunch: ${isAlarmLaunch}, isInAlarmWindow: ${isInAlarmWindow}`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Window State -> Start: ${startMs ? new Date(startMs).toLocaleString() : 'N/A'}, Target/Hard Limit: ${hardLimitMs ? new Date(hardLimitMs).toLocaleString() : 'N/A'}, Current: ${new Date(nowMs).toLocaleString()}`)

    if (isAlarmLaunch || isInAlarmWindow) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm Context Validated -> Invoking runSmartWakeEvaluation()`)
      this.runSmartWakeEvaluation()
    } else {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Manual UI Open Detected -> Skipping automated background evaluation.`)
    }

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.onCreate()`)
  },

  runSmartWakeEvaluation() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.runSmartWakeEvaluation()`)
    try {
      const enabledVal = localStorage.getItem('smart_wake_enabled')
      const isEnabled = String(enabledVal) === 'true' || enabledVal === true

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Reading Storage -> Enabled: ${isEnabled} (Raw: "${enabledVal}")`)

      if (!isEnabled) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Smart Wake is disabled. Aborting evaluation.`)
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.runSmartWakeEvaluation()`)
        return
      }

      const hardLimitMs = Number(localStorage.getItem('smart_wake_hard_limit_ms'))
      const nowMs = Date.now()

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Time Boundary Check -> Current: ${new Date(nowMs).toLocaleString()}, Target Hard Limit: ${new Date(hardLimitMs).toLocaleString()}`)

      // 1. HARD ALARM LIMIT CHECK (Target Time Reached)
      if (hardLimitMs && nowMs >= hardLimitMs) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] HARD LIMIT TRIGGERED (Target Time Reached) -> Executing alarm and rescheduling next day.`)
        this.sendWakeAlert('Hard Target Limit Reached! Time to wake up!')
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

        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ==================== RAW SLEEP DATA DEBUG START ====================`)
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Constants:`, JSON.stringify(constants))
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Raw getStage() Dump:`, JSON.stringify(stages))

        if (stages && Array.isArray(stages) && stages.length > 0) {
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Total Sleep Records Returned: ${stages.length}`)

          stages.forEach((st, idx) => {
            let mappedName = 'UNKNOWN'
            if (st.model === constants.LIGHT_STAGE) mappedName = 'LIGHT_SLEEP'
            else if (st.model === constants.WAKE_STAGE) mappedName = 'WAKE'
            else if (st.model === constants.DEEP_STAGE) mappedName = 'DEEP_SLEEP'
            else if (st.model === constants.REM_STAGE) mappedName = 'REM_SLEEP'

            console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Record [${idx + 1}/${stages.length}] -> Code: ${st.model} (${mappedName}), Start: ${st.start}, Stop: ${st.stop}, Full Record:`, JSON.stringify(st))
          })

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
        } else {
          stageName = 'No Data (Awake/Idle)'
          isOptimalStage = true
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage array empty or null. User likely Awake/Idle. Optimal Wake = TRUE`)
        }
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ==================== RAW SLEEP DATA DEBUG END ====================`)
      } catch (err) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXCEPTION in Sleep Sensor:`, err)
        stageName = `Sensor Error: ${err.message || err}`
        isOptimalStage = true
      }

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Stage Evaluation Result -> Stage Name: "${stageName}", Is Optimal: ${isOptimalStage}`)

      if (isOptimalStage) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] OPTIMAL STAGE DETECTED -> Triggering wake alert, motor vibration, and scheduleNextDayAlarm()`)
        this.sendWakeAlert(`Light sleep detected (${stageName})! Good morning!`)
        this.triggerAlarmVibration()
        this.scheduleNextDayAlarm()
      } else {
        const nextCheckMs = nowMs + 5 * 60 * 1000
        const targetTimeMs = nextCheckMs <= hardLimitMs ? nextCheckMs : hardLimitMs

        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] NON-OPTIMAL STAGE ACTIVE (${stageName}) -> Scheduling next 5-min check for: ${new Date(targetTimeMs).toLocaleString()}`)

        this.cancelExistingAlarm()

        const alarmId = set({
          url: 'page/gt/home/index.page',
          time: Math.floor(targetTimeMs / 1000)
        })

        localStorage.setItem('smart_wake_alarm_id', String(alarmId))
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] 5-Minute Recurring Alarm Set -> ID: ${alarmId}`)
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] FATAL ERROR in runSmartWakeEvaluation():`, e)
    }

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.runSmartWakeEvaluation()`)
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
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Vibration Interval Executing -> Pulse ${count + 1}/6`)
        if (count >= 6) {
          console.log(`[SMART_WAKE_TRACE ${getLogTime()}] 30-second vibration duration completed. Invoking stopVibration()`)
          this.stopVibration()
        } else if (this.globalData.isRinging) {
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
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Clearing vibration interval timer ID: ${this.globalData.vibrationTimer}`)
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
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.cancelExistingAlarm()`)
    try {
      const activeAlarmId = localStorage.getItem('smart_wake_alarm_id')
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Reading active alarm ID from LocalStorage: ${activeAlarmId}`)
      if (activeAlarmId) {
        cancel(Number(activeAlarmId))
        localStorage.removeItem('smart_wake_alarm_id')
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm ID ${activeAlarmId} successfully cancelled and removed from storage.`)
      } else {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] No active alarm ID found in storage. Nothing to cancel.`)
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Cancel alarm exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.cancelExistingAlarm()`)
  },

  scheduleNextDayAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.scheduleNextDayAlarm()`)
    try {
      const targetHour = Number(localStorage.getItem('smart_wake_hour')) || 7
      const targetMin = Number(localStorage.getItem('smart_wake_minute')) || 0

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Target config loaded -> Hour: ${targetHour}, Minute: ${targetMin}`)

      const now = new Date()
      const tomorrowTarget = new Date()

      // Set target to tomorrow (+1 day relative to current date)
      tomorrowTarget.setDate(now.getDate() + 1)
      tomorrowTarget.setHours(targetHour, targetMin, 0, 0)

      const windowStart = new Date(tomorrowTarget.getTime() - 25 * 60 * 1000)
      const hardLimit = new Date(tomorrowTarget.getTime())

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Storing millisecond values into LocalStorage...`)
      localStorage.setItem('smart_wake_target_ms', String(tomorrowTarget.getTime()))
      localStorage.setItem('smart_wake_start_ms', String(windowStart.getTime()))
      localStorage.setItem('smart_wake_hard_limit_ms', String(hardLimit.getTime()))

      this.cancelExistingAlarm()

      const alarmId = set({
        url: 'page/gt/home/index.page',
        time: Math.floor(windowStart.getTime() / 1000)
      })

      localStorage.setItem('smart_wake_alarm_id', String(alarmId))

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] === NEXT DAY ROLLOVER SUCCESS ===`)
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Current Date/Time          : ${now.toLocaleString()}`)
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Tomorrow's Checks Start Time : ${windowStart.toLocaleString()} (Alarm ID: ${alarmId})`)
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Tomorrow's Target Hard Limit : ${hardLimit.toLocaleString()}`)
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Reschedule next day exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.scheduleNextDayAlarm()`)
  },

  onDestroy() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: App.onDestroy()`)
    this.stopVibration()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: App.onDestroy()`)
  }
})