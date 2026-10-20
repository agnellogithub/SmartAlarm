import { Sleep, Vibrator } from '@zos/sensor'
import { LocalStorage } from '@zos/storage'
import { notify } from '@zos/notification'

const localStorage = new LocalStorage()

function getLogTime() {
  const d = new Date()
  const h = d.getHours() < 10 ? `0${d.getHours()}` : d.getHours()
  const m = d.getMinutes() < 10 ? `0${d.getMinutes()}` : d.getMinutes()
  const s = d.getSeconds() < 10 ? `0${d.getSeconds()}` : d.getSeconds()
  const ms = d.getMilliseconds()
  return `${h}:${m}:${s}.${ms}`
}

AppService({
  onInit(p) {
    console.log(`[SMART_WAKE_LOG ${getLogTime()}] =====================================`)
    console.log(`[SMART_WAKE_LOG ${getLogTime()}] Background AppService onInit invoked.`)
    console.log(`[SMART_WAKE_LOG ${getLogTime()}] Params: ${JSON.stringify(p)}`)
    
    this.runBackgroundVerificationTest()
  },

  runBackgroundVerificationTest() {
    try {
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] Reading LocalStorage state...`)
      const enabled = localStorage.getItem('smart_wake_enabled')
      const targetTimeMs = localStorage.getItem('smart_wake_test_trigger_ms')

      console.log(`[SMART_WAKE_LOG ${getLogTime()}] State -> Enabled: ${enabled}, Scheduled Target: ${targetTimeMs}`)

      if (!enabled) {
        console.log(`[SMART_WAKE_LOG ${getLogTime()}] Alarm disabled in LocalStorage. Exiting.`)
        return
      }

      // 1. NOTIFICATION TEST
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] STEP 1: Sending notification...`)
      this.sendNotification(
        '1. Service Active',
        'Background execution SUCCESS!'
      )
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] STEP 1 Complete.`)

      // 2. SLEEP SENSOR TEST
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] STEP 2: Instantiating Sleep sensor...`)
      let stageDescription = 'Unknown'
      try {
        const sleep = new Sleep()
        console.log(`[SMART_WAKE_LOG ${getLogTime()}] Sensor created. Calling updateInfo()...`)
        sleep.updateInfo()

        const stages = sleep.getStage()
        const constants = sleep.getStageConstantObj()

        console.log(`[SMART_WAKE_LOG ${getLogTime()}] Raw Stages: ${JSON.stringify(stages)}`)

        if (stages && stages.length > 0) {
          const lastStage = stages[stages.length - 1].model
          console.log(`[SMART_WAKE_LOG ${getLogTime()}] Stage model code: ${lastStage}`)
          
          switch (lastStage) {
            case constants.LIGHT_STAGE:
              stageDescription = 'Light Sleep'
              break
            case constants.WAKE_STAGE:
              stageDescription = 'Awake'
              break
            case constants.DEEP_STAGE:
              stageDescription = 'Deep Sleep'
              break
            case constants.REM_STAGE:
              stageDescription = 'REM Sleep'
              break
            default:
              stageDescription = `Code: ${lastStage}`
          }
        } else {
          stageDescription = 'No Active Session (Awake/Idle)'
          console.log(`[SMART_WAKE_LOG ${getLogTime()}] Stages array empty.`)
        }
      } catch (err) {
        stageDescription = `Sensor Error: ${err.message || err}`
        console.log(`[SMART_WAKE_LOG ${getLogTime()}] EXCEPTION in Sleep Sensor:`, err)
      }

      console.log(`[SMART_WAKE_LOG ${getLogTime()}] Evaluated Stage: ${stageDescription}`)
      this.sendNotification(
        '2. Sensor Read Result',
        `Sleep Status: ${stageDescription}`
      )
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] STEP 2 Complete.`)

      // 3. VIBRATION TEST
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] STEP 3: Triggering vibrator motor...`)
      this.sendNotification(
        '3. Vibration Test',
        'Vibrating watch motor now for 5s...'
      )
      this.triggerVibration()
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] STEP 3 Complete.`)

      console.log(`[SMART_WAKE_LOG ${getLogTime()}] All test steps completed successfully.`)
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] =====================================`)

    } catch (e) {
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] FATAL SERVICE ERROR:`, e)
      this.sendNotification('Test Error', `Failed: ${e.message || e}`)
    }
  },

  sendNotification(title, content) {
    try {
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] [NOTIFY] "${title}" - "${content}"`)
      notify({
        title: title,
        content: content
      })
    } catch (e) {
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] [NOTIFY_ERROR]:`, e)
    }
  },

  triggerVibration() {
    try {
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] [VIBE] Starting motor...`)
      const vibrator = new Vibrator()
      vibrator.start()

      setTimeout(() => {
        console.log(`[SMART_WAKE_LOG ${getLogTime()}] [VIBE] Stopping motor.`)
        vibrator.stop()
      }, 5000)
    } catch (e) {
      console.log(`[SMART_WAKE_LOG ${getLogTime()}] [VIBE_ERROR]:`, e)
    }
  },

  onDestroy() {
    console.log(`[SMART_WAKE_LOG ${getLogTime()}] Service onDestroy executed.`)
  }
})