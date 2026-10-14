package dev.bigbrotha.ai_assistant

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    private var deviceHealthChannelHandler: DeviceHealthChannelHandler? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        deviceHealthChannelHandler?.dispose()
        deviceHealthChannelHandler = DeviceHealthChannelHandler(
            activity = this,
            messenger = flutterEngine.dartExecutor.binaryMessenger,
        )
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        deviceHealthChannelHandler?.onTrimMemory(level)
    }

    override fun onDestroy() {
        deviceHealthChannelHandler?.dispose()
        deviceHealthChannelHandler = null
        super.onDestroy()
    }
}
