package one.zephyr.mobile.feature.notes

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.ByteArrayInputStream
import java.io.File

private const val PREVIEW_ORIGIN = "https://preview.zephyr.invalid"

/** No remote navigation, file:// permission, mixed content, auth or arbitrary native operations. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun RawImageViewer(file: File, name: String, modifier: Modifier = Modifier, onSibling: (Int) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val sibling by rememberUpdatedState(onSibling)
    val main = remember { Handler(Looper.getMainLooper()) }
    var alive by remember(file) { mutableStateOf(true) }
    val view = remember(file) {
        WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            @Suppress("DEPRECATION")
            settings.allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            settings.allowUniversalAccessFromFileURLs = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.domStorageEnabled = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.setSupportMultipleWindows(false)
            addJavascriptInterface(object {
                @JavascriptInterface fun sibling(delta: Int) {
                    if (delta == -1 || delta == 1) main.post { if (alive) sibling(delta) }
                }
            }, "PreviewBridge")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                    val url = request?.url
                    fun denied() = WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    if (url?.scheme != "https" || url.host != "preview.zephyr.invalid" || url.port != -1) return denied()
                    return runCatching {
                        val path = url.path.orEmpty()
                        val isolation = mapOf(
                            "Cross-Origin-Opener-Policy" to "same-origin",
                            "Cross-Origin-Embedder-Policy" to "require-corp",
                            "Cross-Origin-Resource-Policy" to "same-origin",
                            "Cache-Control" to "no-store",
                        )
                        if (path == "/raw/image") WebResourceResponse("application/octet-stream", null, 200, "OK", isolation, file.inputStream())
                        else {
                            require(path.startsWith("/mobile-preview/") && !path.contains(".."))
                            val mime = when (path.substringAfterLast('.')) {
                                "js", "mjs" -> "application/javascript"
                                "wasm" -> "application/wasm"
                                "css" -> "text/css"
                                "html" -> "text/html"
                                else -> "application/octet-stream"
                            }
                            WebResourceResponse(mime, if (mime == "application/wasm") null else "UTF-8", 200, "OK", isolation, context.assets.open(path.removePrefix("/")))
                        }
                    }.getOrElse { denied() }
                }
            }
            loadUrl("$PREVIEW_ORIGIN/mobile-preview/image.html?name=${android.net.Uri.encode(name)}")
        }
    }
    DisposableEffect(view, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> view.onPause()
                Lifecycle.Event.ON_START -> view.onResume()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            alive = false
            lifecycle.removeObserver(observer)
            view.evaluateJavascript("window.dispatchEvent(new Event('pagehide'))", null)
            view.stopLoading()
            view.removeJavascriptInterface("PreviewBridge")
            view.loadUrl("about:blank")
            view.destroy()
        }
    }
    AndroidView(factory = { view }, modifier = modifier)
}
