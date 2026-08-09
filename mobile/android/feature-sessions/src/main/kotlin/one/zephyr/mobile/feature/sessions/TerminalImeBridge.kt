package one.zephyr.mobile.feature.sessions

import android.content.Context
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager

/**
 * Android key events to terminal strokes.
 *
 * Pure and separate from the View so the whole table is unit testable: KeyEvent.getUnicodeChar is a
 * platform call that returns 0 under a plain JVM, so the resolved character is passed in rather than
 * read here. The View owns the platform call, this owns the decision.
 */
object TerminalKeyMapper {

    /** Set by the platform on a dead key; the IME must resolve it before anything is sent. */
    const val COMBINING_ACCENT = 0x80000000.toInt()

    /**
     * @param unicodeChar KeyEvent.getUnicodeChar with the control modifiers stripped, so Ctrl+C
     *   still resolves to 'c'. Android returns 0 for Ctrl-modified keys otherwise, which would make
     *   every control combination unmappable.
     * @return null when the event is not terminal input and must be left to the system, which is
     *   what keeps Back, volume and the predictive-back gesture working.
     */
    fun map(keyCode: Int, metaState: Int, unicodeChar: Int): TerminalKeyStroke? {
        val ctrl = metaState and KeyEvent.META_CTRL_ON != 0
        val alt = metaState and KeyEvent.META_ALT_ON != 0
        val shift = metaState and KeyEvent.META_SHIFT_ON != 0

        named(keyCode)?.let { key ->
            return TerminalKeyStroke(key = key, ctrl = ctrl, alt = alt, shift = shift)
        }

        // A dead key in progress. Sending it now would type the accent as a standalone character.
        if (unicodeChar and COMBINING_ACCENT != 0) return null
        if (unicodeChar == 0) return null

        // Shift is deliberately dropped: it is already baked into the resolved character, and
        // passing it on would add an xterm modifier parameter to a printable byte.
        return TerminalKeyStroke(
            key = TerminalKey.Character(unicodeChar),
            ctrl = ctrl,
            alt = alt,
            shift = false,
        )
    }

    /** Named keys, which carry their modifiers in the escape sequence rather than in the byte. */
    fun named(keyCode: Int): TerminalKey? = when (keyCode) {
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> TerminalKey.Enter
        KeyEvent.KEYCODE_DEL -> TerminalKey.Backspace
        KeyEvent.KEYCODE_FORWARD_DEL -> TerminalKey.Delete
        KeyEvent.KEYCODE_INSERT -> TerminalKey.Insert
        KeyEvent.KEYCODE_TAB -> TerminalKey.Tab
        KeyEvent.KEYCODE_ESCAPE -> TerminalKey.Escape
        KeyEvent.KEYCODE_DPAD_UP -> TerminalKey.ArrowUp
        KeyEvent.KEYCODE_DPAD_DOWN -> TerminalKey.ArrowDown
        KeyEvent.KEYCODE_DPAD_LEFT -> TerminalKey.ArrowLeft
        KeyEvent.KEYCODE_DPAD_RIGHT -> TerminalKey.ArrowRight
        KeyEvent.KEYCODE_MOVE_HOME -> TerminalKey.Home
        KeyEvent.KEYCODE_MOVE_END -> TerminalKey.End
        KeyEvent.KEYCODE_PAGE_UP -> TerminalKey.PageUp
        KeyEvent.KEYCODE_PAGE_DOWN -> TerminalKey.PageDown
        in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 ->
            TerminalKey.Function(keyCode - KeyEvent.KEYCODE_F1 + 1)
        else -> null
    }

    /**
     * The meta bits that may take part in resolving a printable character.
     *
     * Ctrl and Alt are excluded because the platform treats them as non-printing: asking for the
     * unicode value with Ctrl still set returns 0 and the keystroke would be lost.
     */
    fun printableMeta(metaState: Int): Int =
        metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv()
}

/**
 * The IME anchor for the terminal.
 *
 * A terminal cannot use a text field: TERMINAL_EXPERIENCE.md 3 requires that a composition update
 * moves only the overlay while a commit writes exactly once, and an EditText would insert into its
 * own buffer and then replay edits as key events. This View owns nothing but the InputConnection and
 * forwards each platform callback to exactly one intent, so the single-owner rule survives contact
 * with the IME.
 */
class TerminalImeView(context: Context) : View(context) {

    var onIntent: (TerminalIntent) -> Unit = {}

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        // The view is an input sink, not a target: the terminal draws in Compose above it.
        setWillNotDraw(true)
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        // TYPE_CLASS_TEXT with MULTI_LINE keeps a CJK IME in composing mode and gives the user a
        // newline key rather than a Send action. VISIBLE_PASSWORD would suppress suggestions too,
        // but it also disables composition on most IMEs, which would break pinyin entirely.
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or
            EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_FLAG_NO_ENTER_ACTION
        outAttrs.initialSelStart = 0
        outAttrs.initialSelEnd = 0
        return TerminalInputConnection(this)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Back must reach the system so predictive back can pop the page.
        if (keyCode == KeyEvent.KEYCODE_BACK) return false
        if (event.isSystem) return false

        // A hardware keyboard can deliver a string no key code describes, e.g. a compose sequence.
        if (keyCode == KeyEvent.KEYCODE_UNKNOWN) {
            val characters = event.characters
            if (!characters.isNullOrEmpty()) {
                onIntent(TerminalIntent.Commit(characters))
                return true
            }
            return false
        }

        val unicode = event.getUnicodeChar(TerminalKeyMapper.printableMeta(event.metaState))
        val stroke = TerminalKeyMapper.map(keyCode, event.metaState, unicode) ?: return false
        onIntent(TerminalIntent.KeyStroke(stroke))
        return true
    }

    /** Consumed to match onKeyDown, otherwise the system would act on the release of a mapped key. */
    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK || event.isSystem) return false
        if (keyCode == KeyEvent.KEYCODE_UNKNOWN) return false
        val unicode = event.getUnicodeChar(TerminalKeyMapper.printableMeta(event.metaState))
        return TerminalKeyMapper.map(keyCode, event.metaState, unicode) != null
    }

    /**
     * Shows or hides the soft keyboard.
     *
     * Driven by state rather than toggled blind, so the shortcut matrix key and a tap on the
     * viewport cannot leave the flag and the IME disagreeing.
     */
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
 * The IME contract, mapped one callback at a time.
 *
 * Extends BaseInputConnection with fullEditor false so the platform keeps its dummy editable for the
 * bookkeeping an IME expects, while every path that could produce text is overridden here. Anything
 * not overridden must not reach the PTY, which is why there is no getExtractedText or
 * setComposingRegion: a terminal has no document for the IME to inspect.
 */
private class TerminalInputConnection(private val view: TerminalImeView) :
    BaseInputConnection(view, false) {

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
        val value = text?.toString() ?: ""
        // The cursor the IME reports is relative to the composing text when positive.
        val cursor = if (newCursorPosition > 0) value.length else 0
        view.onIntent(TerminalIntent.Composing(value, cursor))
        return true
    }

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        val value = text?.toString().orEmpty()
        if (value.isEmpty()) {
            // Some IMEs commit an empty string to abandon a composition. Treating it as a finish
            // would write the provisional text the user just rejected.
            view.onIntent(TerminalIntent.CancelComposing)
            return true
        }
        view.onIntent(TerminalIntent.Commit(value))
        return true
    }

    override fun finishComposingText(): Boolean {
        view.onIntent(TerminalIntent.FinishComposing)
        return true
    }

    /** A soft-keyboard backspace. There is no local buffer to delete from, so it becomes a key. */
    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        repeat(beforeLength.coerceAtLeast(0)) {
            view.onIntent(TerminalIntent.KeyStroke(TerminalKeyStroke(TerminalKey.Backspace)))
        }
        repeat(afterLength.coerceAtLeast(0)) {
            view.onIntent(TerminalIntent.KeyStroke(TerminalKeyStroke(TerminalKey.Delete)))
        }
        return true
    }

    override fun sendKeyEvent(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return true
        val unicode = event.getUnicodeChar(TerminalKeyMapper.printableMeta(event.metaState))
        val stroke = TerminalKeyMapper.map(event.keyCode, event.metaState, unicode) ?: return false
        view.onIntent(TerminalIntent.KeyStroke(stroke))
        return true
    }

    /** IME_ACTION_NONE is requested, but an IME may still send one; a terminal reads it as Enter. */
    override fun performEditorAction(editorAction: Int): Boolean {
        view.onIntent(TerminalIntent.KeyStroke(TerminalKeyStroke(TerminalKey.Enter)))
        return true
    }
}
