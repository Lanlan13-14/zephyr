package one.zephyr.mobile.feature.remote

import android.content.Context
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager

/**
 * Android key codes to remote keys.
 *
 * Separate from RdpKeyMap and VncKeyMap on purpose: those two answer "how does this protocol name
 * this key", while this answers "which key did the platform just report". Collapsing them would make
 * the Android key code table a dependency of the protocol adapters.
 */
object RemoteKeyMapper {

    /**
     * @param unicodeChar the value from KeyEvent.getUnicodeChar with the non-printing meta bits
     *   removed, so a Ctrl+C still resolves to the character c and can travel as a scan code.
     */
    fun map(keyCode: Int, metaState: Int, unicodeChar: Int): RemoteKey? {
        named(keyCode)?.let { return it }
        modifier(keyCode)?.let { return it }
        if (keyCode in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12) {
            return RemoteKey.Function(keyCode - KeyEvent.KEYCODE_F1 + 1)
        }
        if (unicodeChar != 0) return RemoteKey.Character(unicodeChar)
        return null
    }

    fun named(keyCode: Int): RemoteKey? = when (keyCode) {
        KeyEvent.KEYCODE_ESCAPE -> RemoteKey.Escape
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> RemoteKey.Enter
        KeyEvent.KEYCODE_DEL -> RemoteKey.Backspace
        KeyEvent.KEYCODE_FORWARD_DEL -> RemoteKey.Delete
        KeyEvent.KEYCODE_TAB -> RemoteKey.Tab
        KeyEvent.KEYCODE_SPACE -> RemoteKey.Space
        KeyEvent.KEYCODE_INSERT -> RemoteKey.Insert
        KeyEvent.KEYCODE_MOVE_HOME -> RemoteKey.Home
        KeyEvent.KEYCODE_MOVE_END -> RemoteKey.End
        KeyEvent.KEYCODE_PAGE_UP -> RemoteKey.PageUp
        KeyEvent.KEYCODE_PAGE_DOWN -> RemoteKey.PageDown
        KeyEvent.KEYCODE_DPAD_UP -> RemoteKey.ArrowUp
        KeyEvent.KEYCODE_DPAD_DOWN -> RemoteKey.ArrowDown
        KeyEvent.KEYCODE_DPAD_LEFT -> RemoteKey.ArrowLeft
        KeyEvent.KEYCODE_DPAD_RIGHT -> RemoteKey.ArrowRight
        KeyEvent.KEYCODE_CAPS_LOCK -> RemoteKey.CapsLock
        KeyEvent.KEYCODE_MENU -> RemoteKey.Menu
        KeyEvent.KEYCODE_SYSRQ -> RemoteKey.PrintScreen
        else -> null
    }

    /**
     * A physical modifier.
     *
     * Left and right are kept apart because the remote side distinguishes them: AltGr is right Alt on
     * a Windows desktop, and folding it into left Alt would make every accented character on a
     * European layout unreachable.
     */
    fun modifier(keyCode: Int): RemoteKey.Modifier? = when (keyCode) {
        KeyEvent.KEYCODE_CTRL_LEFT -> RemoteKey.Modifier(RemoteModifier.CTRL)
        KeyEvent.KEYCODE_CTRL_RIGHT -> RemoteKey.Modifier(RemoteModifier.CTRL, right = true)
        KeyEvent.KEYCODE_ALT_LEFT -> RemoteKey.Modifier(RemoteModifier.ALT)
        KeyEvent.KEYCODE_ALT_RIGHT -> RemoteKey.Modifier(RemoteModifier.ALT, right = true)
        KeyEvent.KEYCODE_SHIFT_LEFT -> RemoteKey.Modifier(RemoteModifier.SHIFT)
        KeyEvent.KEYCODE_SHIFT_RIGHT -> RemoteKey.Modifier(RemoteModifier.SHIFT, right = true)
        // The platform Meta key. Section 6 requires RDP to present this as Win, which RdpKeyMap does.
        KeyEvent.KEYCODE_META_LEFT -> RemoteKey.Modifier(RemoteModifier.META)
        KeyEvent.KEYCODE_META_RIGHT -> RemoteKey.Modifier(RemoteModifier.META, right = true)
        else -> null
    }

    /**
     * Meta bits that may resolve a printable character.
     *
     * Ctrl and Alt are removed because the platform treats them as non-printing and would return 0,
     * losing the keystroke. Shift stays, so Shift+2 still resolves to the layout character.
     */
    fun printableMeta(metaState: Int): Int =
        metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv()
}

/**
 * The IME anchor for a remote session.
 *
 * A zero-sized View rather than a text field, for the same reason as the terminal: there is no local
 * document. The difference from the terminal is that composing text is deliberately *not* forwarded.
 * REMOTE_DESKTOP_EXPERIENCE.md 6 routes IME text through the Unicode/text channel, and a remote
 * desktop has no way to retract a provisional composition - sending each pinyin keystroke would type
 * the phonetic letters into the remote application and then type the chosen characters again.
 */
class RemoteImeView(context: Context) : View(context) {

    var onIntent: (RemoteIntent) -> Unit = {}

    /**
     * Raw hardware key pass-through.
     *
     * Separate from [onIntent] because section 5.3 and 6 require a physical keyboard to pass through
     * with real down and up transitions, while the soft modifier bar latches. Routing both through
     * one intent would force the controller to guess which it was looking at.
     */
    var onHardwareKey: (RemoteKey, Boolean) -> Unit = { _, _ -> }

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        setWillNotDraw(true)
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or
            EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_FLAG_NO_ENTER_ACTION
        outAttrs.initialSelStart = 0
        outAttrs.initialSelEnd = 0
        return RemoteInputConnection(this)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Back must reach the system so predictive back can pop the page.
        if (keyCode == KeyEvent.KEYCODE_BACK) return false
        if (event.isSystem) return false

        // A compose sequence or a macro can deliver a string no key code describes.
        if (keyCode == KeyEvent.KEYCODE_UNKNOWN) {
            val characters = event.characters
            if (!characters.isNullOrEmpty()) {
                onIntent(RemoteIntent.Text(characters))
                return true
            }
            return false
        }

        val key = resolve(keyCode, event) ?: return false
        onHardwareKey(key, true)
        return true
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK || event.isSystem) return false
        if (keyCode == KeyEvent.KEYCODE_UNKNOWN) return false
        val key = resolve(keyCode, event) ?: return false
        onHardwareKey(key, false)
        return true
    }

    private fun resolve(keyCode: Int, event: KeyEvent): RemoteKey? {
        val unicode = event.getUnicodeChar(RemoteKeyMapper.printableMeta(event.metaState))
        return RemoteKeyMapper.map(keyCode, event.metaState, unicode)
    }

    fun setKeyboardVisible(visible: Boolean) {
        val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        if (visible) {
            requestFocus()
            manager.showSoftInput(this, 0)
        } else {
            manager.hideSoftInputFromWindow(windowToken, 0)
        }
    }
}

/**
 * The IME contract, narrowed to what a remote desktop can honour.
 *
 * setComposingText is accepted and dropped rather than left unimplemented: returning false makes
 * some IMEs fall back to sending the composition as individual key events, which is the exact
 * behaviour this class exists to avoid. The commit is the only thing that reaches the wire.
 */
private class RemoteInputConnection(private val view: RemoteImeView) :
    BaseInputConnection(view, false) {

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean = true

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        val value = text?.toString().orEmpty()
        if (value.isNotEmpty()) view.onIntent(RemoteIntent.Text(value))
        return true
    }

    /**
     * A backspace from the IME.
     *
     * There is no local buffer to delete from, so it becomes the key the remote expects. Only the
     * before-cursor count is honoured: an IME asking to delete after the cursor is describing an edit
     * to a document that does not exist here.
     */
    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        repeat(beforeLength.coerceIn(0, MAX_DELETE)) { view.onIntent(RemoteIntent.Key(RemoteKey.Backspace)) }
        return true
    }

    override fun sendKeyEvent(event: KeyEvent?): Boolean {
        val actual = event ?: return false
        val key = RemoteKeyMapper.map(
            keyCode = actual.keyCode,
            metaState = actual.metaState,
            unicodeChar = actual.getUnicodeChar(RemoteKeyMapper.printableMeta(actual.metaState)),
        ) ?: return false
        when (actual.action) {
            KeyEvent.ACTION_DOWN -> view.onHardwareKey(key, true)
            KeyEvent.ACTION_UP -> view.onHardwareKey(key, false)
            else -> return false
        }
        return true
    }

    override fun performEditorAction(editorAction: Int): Boolean {
        view.onIntent(RemoteIntent.Key(RemoteKey.Enter))
        return true
    }

    private companion object {
        /** A runaway IME must not be able to hold the input queue with one call. */
        const val MAX_DELETE = 64
    }
}
