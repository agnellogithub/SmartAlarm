import { createWidget, widget, prop, align } from '@zos/ui'
import { LocalStorage } from '@zos/storage'
import { set, cancel } from '@zos/alarm'

const localStorage = new LocalStorage()

function getLogTime() {
  const d = new Date()
  const h = d.getHours() < 10 ? `0${d.getHours()}` : d.getHours()
  const m = d.getMinutes() < 10 ? `0${d.getMinutes()}` : d.getMinutes()
  const s = d.getSeconds() < 10 ? `0${d.getSeconds()}` : d.getSeconds()
  const ms = d.getMilliseconds()
  return `${h}:${m}:${s}.${ms}`
}

Page({
  state: {
    hour: 7,
    minute: 0,
    enabled: false,
    editing: false,
    mainGroup: [],
    editGroup: [],
    timeTextWidget: null,
    statusTextWidget: null,
    toggleBtnWidget: null,
    editBtnWidget: null,
    editHourWidget: null,
    editMinWidget: null,
    dismissBtnWidget: null
  },

  build() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.build()`)
    this.loadSavedConfig()

    // --- MAIN DISPLAY UI ---
    const titleWidget = createWidget(widget.TEXT, {
      x: 20, y: 45, w: 350, h: 30,
      color: 0x8e44ad, text_size: 20, align_h: align.CENTER_H,
      text: 'Smart Wake (-25m Window)'
    })
    this.state.mainGroup.push(titleWidget)

    this.state.timeTextWidget = createWidget(widget.TEXT, {
      x: 20, y: 80, w: 350, h: 65,
      color: 0x00cec9, text_size: 52, align_h: align.CENTER_H,
      text: this.getFormattedTime()
    })
    this.state.mainGroup.push(this.state.timeTextWidget)

    this.state.editBtnWidget = createWidget(widget.BUTTON, {
      x: 105, y: 150, w: 180, h: 38, radius: 10,
      normal_color: 0x6c5ce7, press_color: 0xa29bfe,
      text: 'Edit Time', text_size: 18,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: "Edit Time" button clicked.`)
        this.showEditScreen(true) 
      }
    })
    this.state.mainGroup.push(this.state.editBtnWidget)

    this.state.statusTextWidget = createWidget(widget.TEXT, {
      x: 20, y: 195, w: 350, h: 40,
      color: 0xf1c40f, text_size: 16, align_h: align.CENTER_H,
      text: 'Status: Disabled'
    })
    this.state.mainGroup.push(this.state.statusTextWidget)

    this.state.toggleBtnWidget = createWidget(widget.BUTTON, {
      x: 50, y: 240, w: 290, h: 45, radius: 12,
      normal_color: this.state.enabled ? 0xd63031 : 0x00b894,
      press_color: this.state.enabled ? 0xff7675 : 0x55efc4,
      text: this.state.enabled ? 'Disable Alarm' : 'Enable Alarm',
      text_size: 20,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Toggle Alarm button clicked.`)
        this.toggleAlarm() 
      }
    })
    this.state.mainGroup.push(this.state.toggleBtnWidget)

    this.state.dismissBtnWidget = createWidget(widget.BUTTON, {
      x: 45, y: 295, w: 300, h: 65, radius: 16,
      normal_color: 0xe67e22, press_color: 0xd35400,
      text: 'DISMISS ALARM', text_size: 24,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: DISMISS ALARM button clicked manually.`)
        this.dismissAlarm() 
      }
    })
    this.state.mainGroup.push(this.state.dismissBtnWidget)

    // --- EDIT TIME MODAL (Off-screen at x=1000) ---
    const editTitle = createWidget(widget.TEXT, {
      x: 1000, y: 40, w: 350, h: 35,
      color: 0xffffff, text_size: 24, align_h: align.CENTER_H,
      text: 'Set Wake Time'
    })

    const hMinus = createWidget(widget.BUTTON, {
      x: 1000, y: 90, w: 75, h: 50, radius: 10,
      normal_color: 0x6c5ce7, press_color: 0xa29bfe, text: '-1h', text_size: 20,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: -1h button clicked.`)
        this.state.hour = (this.state.hour + 23) % 24; 
        this.updateEditDisplay() 
      }
    })
    this.state.editHourWidget = createWidget(widget.TEXT, {
      x: 1000, y: 90, w: 140, h: 50,
      color: 0x00cec9, text_size: 38, align_h: align.CENTER_H,
      text: `${this.state.hour}h`
    })
    const hPlus = createWidget(widget.BUTTON, {
      x: 1000, y: 90, w: 75, h: 50, radius: 10,
      normal_color: 0x6c5ce7, press_color: 0xa29bfe, text: '+1h', text_size: 20,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: +1h button clicked.`)
        this.state.hour = (this.state.hour + 1) % 24; 
        this.updateEditDisplay() 
      }
    })

    const mMinus = createWidget(widget.BUTTON, {
      x: 1000, y: 155, w: 75, h: 50, radius: 10,
      normal_color: 0x6c5ce7, press_color: 0xa29bfe, text: '-5m', text_size: 20,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: -5m button clicked.`)
        this.state.minute = (this.state.minute + 55) % 60; 
        this.updateEditDisplay() 
      }
    })
    this.state.editMinWidget = createWidget(widget.TEXT, {
      x: 1000, y: 155, w: 140, h: 50,
      color: 0x00cec9, text_size: 38, align_h: align.CENTER_H,
      text: `${this.state.minute}m`
    })
    const mPlus = createWidget(widget.BUTTON, {
      x: 1000, y: 155, w: 75, h: 50, radius: 10,
      normal_color: 0x6c5ce7, press_color: 0xa29bfe, text: '+5m', text_size: 20,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: +5m button clicked.`)
        this.state.minute = (this.state.minute + 5) % 60; 
        this.updateEditDisplay() 
      }
    })

    const saveBtn = createWidget(widget.BUTTON, {
      x: 1000, y: 230, w: 290, h: 55, radius: 12,
      normal_color: 0x00b894, press_color: 0x55efc4,
      text: 'Done', text_size: 22,
      click_func: () => { 
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: "Done" button clicked on edit screen.`)
        this.saveTimeAndReturn() 
      }
    })

    this.state.editGroup = [editTitle, hMinus, this.state.editHourWidget, hPlus, mMinus, this.state.editMinWidget, mPlus, saveBtn]

    this.updateStatusDisplay()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.build()`)
  },

  loadSavedConfig() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.loadSavedConfig()`)
    try {
      const savedHour = localStorage.getItem('smart_wake_hour')
      const savedMin = localStorage.getItem('smart_wake_minute')
      const savedEnabled = localStorage.getItem('smart_wake_enabled')

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Loaded Values -> Hour: ${savedHour}, Minute: ${savedMin}, Enabled: ${savedEnabled}`)

      if (savedHour !== undefined && savedHour !== null) this.state.hour = Number(savedHour)
      if (savedMin !== undefined && savedMin !== null) this.state.minute = Number(savedMin)
      if (savedEnabled !== undefined && savedEnabled !== null) {
        this.state.enabled = String(savedEnabled) === 'true'
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] loadSavedConfig exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.loadSavedConfig()`)
  },

  getFormattedTime() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.getFormattedTime()`)
    const h = this.state.hour < 10 ? `0${this.state.hour}` : `${this.state.hour}`
    const m = this.state.minute < 10 ? `0${this.state.minute}` : `${this.state.minute}`
    const result = `${h}:${m}`
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.getFormattedTime() | Result: "${result}"`)
    return result
  },

  showEditScreen(show) {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.showEditScreen() | Show: ${show}`)
    this.state.editing = show

    if (show) {
      this.state.mainGroup.forEach(w => w.setProperty(prop.X, 1000))

      const e = this.state.editGroup
      e[0].setProperty(prop.X, 20)  // Title
      e[1].setProperty(prop.X, 35)  // hMinus
      e[2].setProperty(prop.X, 125) // Hour Text
      e[3].setProperty(prop.X, 280) // hPlus
      e[4].setProperty(prop.X, 35)  // mMinus
      e[5].setProperty(prop.X, 125) // Min Text
      e[6].setProperty(prop.X, 280) // mPlus
      e[7].setProperty(prop.X, 50)  // Save Btn

      this.updateEditDisplay()
    } else {
      this.state.mainGroup[0].setProperty(prop.X, 20)  // Title
      this.state.mainGroup[1].setProperty(prop.X, 20)  // Time Text
      this.state.mainGroup[2].setProperty(prop.X, 105) // Edit Button
      this.state.mainGroup[3].setProperty(prop.X, 20)  // Status Text
      this.state.mainGroup[4].setProperty(prop.X, 50)  // Toggle Button
      this.state.mainGroup[5].setProperty(prop.X, 45)  // Dismiss Button

      this.state.editGroup.forEach(w => w.setProperty(prop.X, 1000))

      if (this.state.timeTextWidget) {
        this.state.timeTextWidget.setProperty(prop.TEXT, this.getFormattedTime())
      }
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.showEditScreen()`)
  },

  updateEditDisplay() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.updateEditDisplay()`)
    if (this.state.editHourWidget && this.state.editMinWidget) {
      const hStr = this.state.hour < 10 ? `0${this.state.hour}` : `${this.state.hour}`
      const mStr = this.state.minute < 10 ? `0${this.state.minute}` : `${this.state.minute}`
      this.state.editHourWidget.setProperty(prop.TEXT, `${hStr}h`)
      this.state.editMinWidget.setProperty(prop.TEXT, `${mStr}m`)
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Edit Display Updated -> ${hStr}h ${mStr}m`)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.updateEditDisplay()`)
  },

  saveTimeAndReturn() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.saveTimeAndReturn()`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Persisting target time -> Hour: ${this.state.hour}, Minute: ${this.state.minute}`)
    localStorage.setItem('smart_wake_hour', String(this.state.hour))
    localStorage.setItem('smart_wake_minute', String(this.state.minute))

    if (this.state.enabled) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm is enabled. Re-scheduling service for new time...`)
      this.scheduleAlarmService()
    }

    this.showEditScreen(false)
    this.updateStatusDisplay()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.saveTimeAndReturn()`)
  },

  dismissAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.dismissAlarm()`)
    try {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Invoking getApp().stopVibration()...`)
      getApp().stopVibration()

      // EXPLICIT CHECK: If alarm is actively enabled, ensure tomorrow's alarm is locked in
      if (this.state.enabled) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm is active -> Invoking getApp().scheduleNextDayAlarm() from dismiss action...`)
        getApp().scheduleNextDayAlarm()
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] dismissAlarm exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.dismissAlarm()`)
  },

  toggleAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.toggleAlarm()`)
    this.dismissAlarm()

    this.state.enabled = !this.state.enabled
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] New Alarm State: ${this.state.enabled}`)
    localStorage.setItem('smart_wake_enabled', this.state.enabled ? 'true' : 'false')

    if (this.state.enabled) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Enabling alarm service...`)
      this.scheduleAlarmService()
    } else {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Disabling alarm service...`)
      this.cancelAlarmService()
    }

    this.updateStatusDisplay()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.toggleAlarm()`)
  },

  scheduleAlarmService() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.scheduleAlarmService()`)
    this.cancelAlarmService()

    const hour = Number(this.state.hour)
    const min = Number(this.state.minute)

    const now = new Date()
    const targetTime = new Date()

    // 1. Target time set to today first
    targetTime.setHours(hour, min, 0, 0)

    // 2. Calculate window start (-25m) and hard limit (0m offset)
    let windowStart = new Date(targetTime.getTime() - 25 * 60 * 1000)
    let hardLimit = new Date(targetTime.getTime())

    // 3. Date Boundary Check:
    // If window start has already passed today, shift target to tomorrow
    if (windowStart.getTime() <= now.getTime()) {
      targetTime.setDate(targetTime.getDate() + 1)
      windowStart = new Date(targetTime.getTime() - 25 * 60 * 1000)
      hardLimit = new Date(targetTime.getTime())
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Window start time passed today. Target shifted to TOMORROW.`)
    } else {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Target window is in the future. Scheduled for TODAY.`)
    }

    localStorage.setItem('smart_wake_target_ms', String(targetTime.getTime()))
    localStorage.setItem('smart_wake_start_ms', String(windowStart.getTime()))
    localStorage.setItem('smart_wake_hard_limit_ms', String(hardLimit.getTime()))

    const startSeconds = Math.floor(windowStart.getTime() / 1000)
    
    const alarmId = set({
      url: 'page/gt/home/index.page',
      time: startSeconds
    })

    localStorage.setItem('smart_wake_alarm_id', String(alarmId))

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] === MANUAL SCHEDULE VERIFICATION ===`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Current Date/Time  : ${now.toLocaleString()}`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Checks Start Time : ${windowStart.toLocaleString()} (Alarm ID: ${alarmId})`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Target Hard Limit : ${hardLimit.toLocaleString()}`)

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.scheduleAlarmService()`)
  },

  cancelAlarmService() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.cancelAlarmService()`)
    try {
      this.dismissAlarm()

      const activeAlarmId = localStorage.getItem('smart_wake_alarm_id')
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Active Alarm ID read from storage: ${activeAlarmId}`)
      if (activeAlarmId) {
        cancel(Number(activeAlarmId))
        localStorage.removeItem('smart_wake_alarm_id')
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm ID ${activeAlarmId} successfully cancelled.`)
      } else {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] No active alarm ID found to cancel.`)
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] cancelAlarmService exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.cancelAlarmService()`)
  },

  updateStatusDisplay() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.updateStatusDisplay()`)
    if (this.state.statusTextWidget && this.state.toggleBtnWidget) {
      if (this.state.timeTextWidget) {
        this.state.timeTextWidget.setProperty(prop.TEXT, this.getFormattedTime())
      }

      if (this.state.enabled) {
        const startMs = localStorage.getItem('smart_wake_start_ms')
        let checkStr = ''
        if (startMs) {
          const sDate = new Date(Number(startMs))
          const sh = sDate.getHours() < 10 ? `0${sDate.getHours()}` : sDate.getHours()
          const sm = sDate.getMinutes() < 10 ? `0${sDate.getMinutes()}` : sDate.getMinutes()
          checkStr = `\nChecks start at ${sh}:${sm}`
        }

        this.state.statusTextWidget.setProperty(prop.TEXT, `Status: Active${checkStr}`)
        this.state.toggleBtnWidget.setProperty(prop.TEXT, 'Disable Alarm')
        this.state.toggleBtnWidget.setProperty(prop.NORMAL_COLOR, 0xd63031)
        this.state.toggleBtnWidget.setProperty(prop.PRESS_COLOR, 0xff7675)
      } else {
        this.state.statusTextWidget.setProperty(prop.TEXT, 'Status: Disabled')
        this.state.toggleBtnWidget.setProperty(prop.TEXT, 'Enable Alarm')
        this.state.toggleBtnWidget.setProperty(prop.NORMAL_COLOR, 0x00b894)
        this.state.toggleBtnWidget.setProperty(prop.PRESS_COLOR, 0x55efc4)
      }
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Status display refreshed. Active: ${this.state.enabled}`)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.updateStatusDisplay()`)
  }
})