import { trace } from './utils/index'

// Wake checks run in the background service (app-service/index.js) and the ring screen vibrates,
// so the App itself only logs its lifecycle. It no longer evaluates on open: that ran a second check
// alongside the service and could ring twice.
App({
  globalData: {},

  onCreate(options) {
    trace(`App.onCreate() | Options: ${JSON.stringify(options)}`)
  },

  onDestroy() {
    trace('App.onDestroy()')
  }
})
