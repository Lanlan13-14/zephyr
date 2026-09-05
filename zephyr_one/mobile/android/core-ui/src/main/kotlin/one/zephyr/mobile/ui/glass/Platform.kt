package one.zephyr.mobile.ui.glass

import android.os.Build
import androidx.annotation.ChecksSdkIntAtLeast

/**
 * Process-wide kill switch for the liquid-glass GPU path.
 *
 * AGSL compile errors and driver aborts (Adreno SIGSEGV on a
 * zero-length unit vector during the first island frame) must not take
 * the activity down. After a failure, glass degrades to tinted rounded
 * rects for the rest of the process.
 */
internal object GlassRuntime {
    @Volatile var shadersEnabled: Boolean = true
        private set
    @Volatile var effectsEnabled: Boolean = true
        private set

    fun disableShaders() {
        shadersEnabled = false
    }

    fun disableEffects() {
        shadersEnabled = false
        effectsEnabled = false
    }

    fun resetForTests() {
        shadersEnabled = true
        effectsEnabled = true
    }
}

@ChecksSdkIntAtLeast(api = Build.VERSION_CODES.S)
fun isRenderEffectSupported(): Boolean =
    GlassRuntime.effectsEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

@ChecksSdkIntAtLeast(api = Build.VERSION_CODES.TIRAMISU)
fun isRuntimeShaderSupported(): Boolean =
    GlassRuntime.shadersEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
