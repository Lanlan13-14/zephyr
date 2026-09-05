package one.zephyr.mobile.ui.glass

import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import org.intellij.lang.annotations.Language

interface RuntimeShader {
    fun setFloatUniform(name: String, value: Float)
    fun setFloatUniform(name: String, value1: Float, value2: Float)
    fun setFloatUniform(name: String, value1: Float, value2: Float, value3: Float)
    fun setFloatUniform(name: String, value1: Float, value2: Float, value3: Float, value4: Float)
    fun setFloatUniform(name: String, values: FloatArray)

    fun setIntUniform(name: String, value: Int)
    fun setIntUniform(name: String, value1: Int, value2: Int)
    fun setIntUniform(name: String, value1: Int, value2: Int, value3: Int)
    fun setIntUniform(name: String, value1: Int, value2: Int, value3: Int, value4: Int)
    fun setIntUniform(name: String, values: IntArray)

    fun setColorUniform(name: String, color: Color)
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
class AndroidRuntimeShader(val shader: android.graphics.RuntimeShader) : RuntimeShader {
    override fun setFloatUniform(name: String, value: Float) {
        shader.setFloatUniform(name, value)
    }

    override fun setFloatUniform(name: String, value1: Float, value2: Float) {
        shader.setFloatUniform(name, value1, value2)
    }

    override fun setFloatUniform(name: String, value1: Float, value2: Float, value3: Float) {
        shader.setFloatUniform(name, value1, value2, value3)
    }

    override fun setFloatUniform(name: String, value1: Float, value2: Float, value3: Float, value4: Float) {
        shader.setFloatUniform(name, value1, value2, value3, value4)
    }

    override fun setFloatUniform(name: String, values: FloatArray) {
        shader.setFloatUniform(name, values)
    }

    override fun setIntUniform(name: String, value: Int) {
        shader.setIntUniform(name, value)
    }

    override fun setIntUniform(name: String, value1: Int, value2: Int) {
        shader.setIntUniform(name, value1, value2)
    }

    override fun setIntUniform(name: String, value1: Int, value2: Int, value3: Int) {
        shader.setIntUniform(name, value1, value2, value3)
    }

    override fun setIntUniform(name: String, value1: Int, value2: Int, value3: Int, value4: Int) {
        shader.setIntUniform(name, value1, value2, value3, value4)
    }

    override fun setIntUniform(name: String, values: IntArray) {
        shader.setIntUniform(name, values)
    }

    override fun setColorUniform(name: String, color: Color) {
        shader.setColorUniform(name, color.toArgb())
    }
}

internal object NoOpRuntimeShader : RuntimeShader {
    override fun setFloatUniform(name: String, value: Float) {}
    override fun setFloatUniform(name: String, value1: Float, value2: Float) {}
    override fun setFloatUniform(name: String, value1: Float, value2: Float, value3: Float) {}
    override fun setFloatUniform(name: String, value1: Float, value2: Float, value3: Float, value4: Float) {}
    override fun setFloatUniform(name: String, values: FloatArray) {}
    override fun setIntUniform(name: String, value: Int) {}
    override fun setIntUniform(name: String, value1: Int, value2: Int) {}
    override fun setIntUniform(name: String, value1: Int, value2: Int, value3: Int) {}
    override fun setIntUniform(name: String, value1: Int, value2: Int, value3: Int, value4: Int) {}
    override fun setIntUniform(name: String, values: IntArray) {}
    override fun setColorUniform(name: String, color: Color) {}
}

fun createRuntimeShader(@Language("AGSL") shaderString: String): RuntimeShader {
    return if (isRuntimeShaderSupported()) {
        AndroidRuntimeShader(android.graphics.RuntimeShader(shaderString))
    } else {
        NoOpRuntimeShader
    }
}

fun RuntimeShader.asAndroidRuntimeShader(): android.graphics.RuntimeShader? {
    return (this as? AndroidRuntimeShader)?.shader
}

interface RuntimeShaderCache {
    fun obtainRuntimeShader(key: String, @Language("AGSL") string: String): RuntimeShader
}

class RuntimeShaderCacheImpl : RuntimeShaderCache {
    private val runtimeShaders = mutableMapOf<String, RuntimeShader>()

    override fun obtainRuntimeShader(key: String, string: String): RuntimeShader {
        return runtimeShaders.getOrPut(key) { createRuntimeShader(string) }
    }

    fun clear() {
        runtimeShaders.clear()
    }
}
