package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The clipboard gate from REMOTE_DESKTOP_EXPERIENCE.md 7.
 *
 * The ordering inside decide() is the whole contract, so it is tested as an order rather than as six
 * independent branches: a remote-to-local offer must be confirmed even under 总是允许, and both
 * blocking checks must run before any policy is consulted. Getting that sequence wrong is how a
 * "always allow" grant for sending turns into the far side silently rewriting the phone's clipboard.
 */
class RemoteClipboardTest {

    private val smallText = RemoteClipboard.textOffer("hello", fromRemote = false)

    @Test
    fun aDisabledChannelBlocksBeforeAnythingElseIsConsidered() {
        val decision = RemoteClipboard.decide(
            offer = smallText,
            channelEnabled = false,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ALWAYS,
        )
        assertEquals(
            RemoteClipboardDecision.Blocked(RemoteClipboard.REASON_CHANNEL_OFF),
            decision,
        )
    }

    @Test
    fun aMissingCapabilityBlocksWithItsOwnReason() {
        /* Separate from the channel reason on purpose: one is a setting the user owns, the other is a
         * grant only the sharing owner can widen, and telling the user to check the wrong one wastes
         * their time. */
        val decision = RemoteClipboard.decide(
            offer = smallText,
            channelEnabled = true,
            allowedByAcl = false,
            policy = RemoteClipboardPolicy.ALWAYS,
        )
        assertEquals(
            RemoteClipboardDecision.Blocked(RemoteClipboard.REASON_NO_CAPABILITY),
            decision,
        )
    }

    @Test
    fun theChannelIsCheckedBeforeTheAcl() {
        // With both wrong, the reported reason is the one the user can actually fix themselves.
        val decision = RemoteClipboard.decide(
            offer = smallText,
            channelEnabled = false,
            allowedByAcl = false,
            policy = RemoteClipboardPolicy.ASK,
        )
        assertEquals(
            RemoteClipboardDecision.Blocked(RemoteClipboard.REASON_CHANNEL_OFF),
            decision,
        )
    }

    @Test
    fun remoteToLocalIsConfirmedEvenUnderAlwaysAllow() {
        /* The frozen rule: 总是允许 was granted for sending, not for letting the far side overwrite
         * what is on the device. A remote desktop can read its own clipboard whenever it likes. */
        val offer = RemoteClipboard.textOffer("from the server", fromRemote = true)
        val decision = RemoteClipboard.decide(
            offer = offer,
            channelEnabled = true,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ALWAYS,
        )
        assertEquals(
            RemoteClipboardDecision.Confirm(offer, RemoteClipboard.REASON_REMOTE_WRITE),
            decision,
        )
    }

    @Test
    fun remoteToLocalOutranksTheLargePayloadReason() {
        // Both would confirm, but the sheet must explain the direction, which is the surprising part.
        val offer = RemoteClipboard.textOffer("x".repeat(RemoteClipboard.LARGE_TEXT_BYTES + 1), fromRemote = true)
        val decision = RemoteClipboard.decide(
            offer = offer,
            channelEnabled = true,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ALWAYS,
        )
        assertEquals(RemoteClipboard.REASON_REMOTE_WRITE, (decision as RemoteClipboardDecision.Confirm).reason)
    }

    @Test
    fun askIsTheDefaultAndConfirmsEvenATinyPaste() {
        val decision = RemoteClipboard.decide(
            offer = smallText,
            channelEnabled = true,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ASK,
        )
        assertEquals(
            RemoteClipboardDecision.Confirm(smallText, RemoteClipboard.REASON_ASK),
            decision,
        )
    }

    @Test
    fun allowOnceTransfersASmallTextWithoutAsking() {
        val decision = RemoteClipboard.decide(
            offer = smallText,
            channelEnabled = true,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ALLOW_ONCE,
        )
        assertEquals(RemoteClipboardDecision.Transfer(smallText), decision)
    }

    @Test
    fun alwaysTransfersASmallTextWithoutAsking() {
        val decision = RemoteClipboard.decide(
            offer = smallText,
            channelEnabled = true,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ALWAYS,
        )
        assertEquals(RemoteClipboardDecision.Transfer(smallText), decision)
    }

    @Test
    fun aLargeTextIsConfirmedNoMatterHowPermissiveThePolicyIs() {
        // A multi-megabyte paste is not what a Ctrl+V meant, whatever was granted earlier.
        val offer = RemoteClipboard.textOffer("x".repeat(RemoteClipboard.LARGE_TEXT_BYTES + 1), fromRemote = false)
        assertTrue(offer.needsConfirmation)
        val decision = RemoteClipboard.decide(
            offer = offer,
            channelEnabled = true,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ALWAYS,
        )
        assertEquals(RemoteClipboard.REASON_LARGE, (decision as RemoteClipboardDecision.Confirm).reason)
    }

    @Test
    fun theLargeTextThresholdIsExclusive() {
        val atLimit = RemoteClipboardOffer(
            kind = RemoteClipboardKind.TEXT,
            byteCount = RemoteClipboard.LARGE_TEXT_BYTES,
            fromRemote = false,
        )
        assertFalse(atLimit.needsConfirmation)

        val overLimit = atLimit.copy(byteCount = RemoteClipboard.LARGE_TEXT_BYTES + 1)
        assertTrue(overLimit.needsConfirmation)
    }

    @Test
    fun imagesAndFilesAreAlwaysConfirmedRegardlessOfSize() {
        /* Size is not the only cost: an image goes through a decoder and a file offer can be a
         * directory tree, so neither is ever a silent transfer. */
        val image = RemoteClipboardOffer(RemoteClipboardKind.IMAGE, byteCount = 8, fromRemote = false)
        val files = RemoteClipboardOffer(RemoteClipboardKind.FILES, byteCount = 0, fromRemote = false)
        assertTrue(image.needsConfirmation)
        assertTrue(files.needsConfirmation)

        val decision = RemoteClipboard.decide(
            offer = image,
            channelEnabled = true,
            allowedByAcl = true,
            policy = RemoteClipboardPolicy.ALWAYS,
        )
        assertEquals(RemoteClipboard.REASON_LARGE, (decision as RemoteClipboardDecision.Confirm).reason)
    }

    @Test
    fun aShortPreviewIsLeftAlone() {
        assertEquals("hello", RemoteClipboard.preview("hello"))
        val exact = "a".repeat(RemoteClipboard.PREVIEW_CHARS)
        assertEquals(exact, RemoteClipboard.preview(exact))
    }

    @Test
    fun aLongPreviewIsCutAndMarked() {
        val preview = RemoteClipboard.preview("a".repeat(200))
        assertEquals(RemoteClipboard.PREVIEW_CHARS + 1, preview.length)
        assertTrue(preview.endsWith("…"))
        assertEquals("a".repeat(RemoteClipboard.PREVIEW_CHARS) + "…", preview)
    }

    @Test
    fun theCutNeverSplitsASurrogatePair() {
        /* An emoji straddling the boundary would otherwise render as a replacement glyph, which looks
         * like the clipboard corrupted the text rather than like a preview being short. */
        val emoji = "\uD83D\uDE00"
        val text = "a".repeat(RemoteClipboard.PREVIEW_CHARS - 1) + emoji
        val preview = RemoteClipboard.preview(text)

        // Backed off one character rather than splitting: the pair is dropped whole.
        assertEquals("a".repeat(RemoteClipboard.PREVIEW_CHARS - 1) + "…", preview)
        assertFalse(preview.contains(emoji))
        assertFalse(Character.isHighSurrogate(preview[preview.length - 2]))
    }

    @Test
    fun aTextOfferMeasuresBytesNotCharacters() {
        /* The confirmation threshold is a byte budget, and a Chinese paste is three bytes a character:
         * counting characters would let three times the intended payload through unconfirmed. */
        val offer = RemoteClipboard.textOffer("你好", fromRemote = false)
        assertEquals(RemoteClipboardKind.TEXT, offer.kind)
        assertEquals(6, offer.byteCount)
        assertEquals("你好", offer.preview)
        assertFalse(offer.fromRemote)
        assertFalse(offer.needsConfirmation)
    }

    @Test
    fun aTextOfferCarriesTheTruncatedPreviewNotTheWholePayload() {
        // The preview exists only to be drawn, so it must not be the payload by another name.
        val offer = RemoteClipboard.textOffer("b".repeat(5_000), fromRemote = false)
        assertEquals(5_000, offer.byteCount)
        assertEquals(RemoteClipboard.PREVIEW_CHARS + 1, offer.preview?.length)
    }

    @Test
    fun onlyAlwaysSurvivesTheSession() {
        assertFalse(RemoteClipboardPolicy.ASK.isPersistent)
        assertFalse(RemoteClipboardPolicy.ALLOW_ONCE.isPersistent)
        assertTrue(RemoteClipboardPolicy.ALWAYS.isPersistent)
    }

    @Test
    fun everyPolicyAndKindIsLabelled() {
        assertEquals("每次询问", RemoteClipboardPolicy.ASK.label)
        assertEquals("本次允许", RemoteClipboardPolicy.ALLOW_ONCE.label)
        assertEquals("总是允许", RemoteClipboardPolicy.ALWAYS.label)
        assertEquals("文本", RemoteClipboardKind.TEXT.label)
        assertEquals("图片", RemoteClipboardKind.IMAGE.label)
        assertEquals("文件", RemoteClipboardKind.FILES.label)
    }

    @Test
    fun everyBlockedAndConfirmReasonIsDistinct() {
        // Two reasons rendering the same sentence would make the sheet unactionable.
        val reasons = listOf(
            RemoteClipboard.REASON_CHANNEL_OFF,
            RemoteClipboard.REASON_NO_CAPABILITY,
            RemoteClipboard.REASON_ASK,
            RemoteClipboard.REASON_LARGE,
            RemoteClipboard.REASON_REMOTE_WRITE,
        )
        assertEquals(reasons.size, reasons.toSet().size)
        for (reason in reasons) assertTrue(reason.isNotBlank())
    }
}
