package dev.bigbrotha.ai_assistant

import android.annotation.TargetApi
import android.app.Activity
import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executor

class DeviceHealthChannelHandler(
    private val activity: Activity,
    messenger: BinaryMessenger,
) : MethodChannel.MethodCallHandler {
    private val methodChannel = MethodChannel(messenger, METHOD_CHANNEL)
    private val thermalChannel = EventChannel(messenger, THERMAL_CHANNEL)
    private val lowMemoryChannel = EventChannel(messenger, LOW_MEMORY_CHANNEL)
    private val activityManager =
        activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    private val powerManager =
        activity.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val thermalExecutor = Executor { command ->
        Handler(Looper.getMainLooper()).post(command)
    }
    private val thermalStreamHandler = object : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
            if (disposed) return
            thermalSubscriptionGeneration = generationOf(arguments)
            thermalSink = events
            events.success(currentThermalStatusName())
        }

        override fun onCancel(arguments: Any?) {
            if (generationOf(arguments) == thermalSubscriptionGeneration) {
                thermalSink = null
                thermalSubscriptionGeneration = null
            }
        }
    }
    private val lowMemoryStreamHandler = object : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
            if (disposed) return
            lowMemorySubscriptionGeneration = generationOf(arguments)
            lowMemorySink = events
            events.success(systemLowMemory)
        }

        override fun onCancel(arguments: Any?) {
            if (generationOf(arguments) == lowMemorySubscriptionGeneration) {
                lowMemorySink = null
                lowMemorySubscriptionGeneration = null
            }
        }
    }

    private var systemLowMemory = false
    private var thermalSink: EventChannel.EventSink? = null
    private var lowMemorySink: EventChannel.EventSink? = null
    private var thermalSubscriptionGeneration: Int? = null
    private var lowMemorySubscriptionGeneration: Int? = null
    private var thermalStatusListener: Any? = null
    // Keep warning latches transient on both platforms: a delayed check and
    // every getSnapshot re-read the platform memory state.
    private val lowMemoryResetHandler = Handler(Looper.getMainLooper())
    private val lowMemoryResetRunnable = Runnable {
        if (!disposed) setSystemLowMemory(readSystemLowMemory())
    }
    private var disposed = false

    init {
        methodChannel.setMethodCallHandler(this)
        thermalChannel.setStreamHandler(thermalStreamHandler)
        lowMemoryChannel.setStreamHandler(lowMemoryStreamHandler)
        startThermalListener()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != GET_SNAPSHOT) {
            result.notImplemented()
            return
        }
        result.success(snapshot())
    }

    fun onTrimMemory(level: Int) {
        if (disposed) return
        val next = when (level) {
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW,
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL,
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE,
            ComponentCallbacks2.TRIM_MEMORY_BACKGROUND,
            ComponentCallbacks2.TRIM_MEMORY_MODERATE,
            ComponentCallbacks2.TRIM_MEMORY_COMPLETE,
            -> true

            else -> readSystemLowMemory()
        }
        setSystemLowMemory(next)
        if (next) scheduleLowMemoryReset()
    }

    private fun setSystemLowMemory(value: Boolean) {
        if (systemLowMemory == value) return
        systemLowMemory = value
        lowMemorySink?.success(value)
        if (value) {
            scheduleLowMemoryReset()
        } else {
            lowMemoryResetHandler.removeCallbacks(lowMemoryResetRunnable)
        }
    }

    private fun scheduleLowMemoryReset() {
        lowMemoryResetHandler.removeCallbacks(lowMemoryResetRunnable)
        lowMemoryResetHandler.postDelayed(
            lowMemoryResetRunnable,
            LOW_MEMORY_RESET_DELAY_MS,
        )
    }

    private fun generationOf(arguments: Any?): Int? =
        (arguments as? Number)?.toInt()

    fun dispose() {
        if (disposed) return
        disposed = true
        methodChannel.setMethodCallHandler(null)
        thermalChannel.setStreamHandler(null)
        lowMemoryChannel.setStreamHandler(null)
        thermalSink = null
        lowMemorySink = null
        thermalSubscriptionGeneration = null
        lowMemorySubscriptionGeneration = null
        lowMemoryResetHandler.removeCallbacks(lowMemoryResetRunnable)
        val listener = thermalStatusListener
        thermalStatusListener = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && listener != null) {
            try {
                powerManager.removeThermalStatusListener(
                    listener as PowerManager.OnThermalStatusChangedListener,
                )
            } catch (_: RuntimeException) {
            }
        }
    }

    private fun startThermalListener() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val listener = PowerManager.OnThermalStatusChangedListener { status ->
            thermalSink?.success(thermalStatusName(status))
        }
        try {
            powerManager.addThermalStatusListener(thermalExecutor, listener)
            thermalStatusListener = listener
        } catch (_: RuntimeException) {
        }
    }

    private fun snapshot(): Map<String, Any?> {
        val memoryInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memoryInfo)
        setSystemLowMemory(memoryInfo.lowMemory)
        return mapOf(
            "physicalMemoryBytes" to memoryInfo.totalMem,
            "freeStorageBytes" to availableStorageBytes(),
            "systemLowMemory" to systemLowMemory,
            "thermalStatus" to currentThermalStatusName(),
        )
    }

    private fun readSystemLowMemory(): Boolean {
        return try {
            val memoryInfo = ActivityManager.MemoryInfo()
            activityManager.getMemoryInfo(memoryInfo)
            memoryInfo.lowMemory
        } catch (_: RuntimeException) {
            false
        }
    }

    private fun availableStorageBytes(): Long? = try {
        StatFs(activity.filesDir.path).availableBytes
    } catch (_: RuntimeException) {
        null
    }

    private fun currentThermalStatusName(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return THERMAL_UNKNOWN
        return thermalStatusName(powerManager.getCurrentThermalStatus())
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private fun thermalStatusName(status: Int): String = when (status) {
        PowerManager.THERMAL_STATUS_NONE -> "nominal"
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
        else -> THERMAL_UNKNOWN
    }

    companion object {
        const val METHOD_CHANNEL = "dev.bigbrotha.ai_assistant/voice/device_health"
        const val THERMAL_CHANNEL =
            "dev.bigbrotha.ai_assistant/voice/device_health/thermal"
        const val LOW_MEMORY_CHANNEL =
            "dev.bigbrotha.ai_assistant/voice/device_health/low_memory"
        const val GET_SNAPSHOT = "getSnapshot"
        const val THERMAL_UNKNOWN = "unknown"
        const val LOW_MEMORY_RESET_DELAY_MS = 2_000L
    }
}
