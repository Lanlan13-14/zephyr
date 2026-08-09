package one.zephyr.mobile.feature.notes

/** Why a command was flagged. Codes only; the dialog wording lives in strings.xml. */
enum class DangerCode {
    RECURSIVE_DELETE,
    FILESYSTEM_FORMAT,
    RAW_DISK_WRITE,
    PRIVILEGE_ESCALATION,
    PIPE_DOWNLOAD_TO_SHELL,
    FORK_BOMB,
    POWER_STATE,
    HISTORY_WIPE,
    CRITICAL_PATH_OVERWRITE,
    PERMISSION_RESET,
}

/**
 * Heuristic classifier for the S33 confirmation policy.
 *
 * SCREEN_CATALOG.md 14 requires a dangerous command to keep going through the confirmation policy
 * even when the connection carries EXECUTE and even when autoRun is set. This class decides *when*
 * to prompt; it is deliberately a heuristic and never a security boundary, because a shell can
 * express every one of these in a form no pattern list will catch. The frozen rule therefore runs
 * one way only: a flagged command must be confirmed, and an unflagged command is still executed
 * under the connection's own capability rather than under this file's approval.
 *
 * Matching happens per shell segment so a quoted mention inside an echo does not raise a false
 * alarm, and false positives are preferred to false negatives: an extra dialog costs a tap, a
 * missed rm -rf costs a filesystem.
 */
object DangerousCommand {

    fun isDangerous(command: String): Boolean = classify(command).isNotEmpty()

    fun classify(command: String): Set<DangerCode> {
        if (command.isBlank()) return emptySet()
        val codes = LinkedHashSet<DangerCode>()
        val segments = segmentsOf(command)

        for (segment in segments) {
            val raw = rawWords(segment)
            val commands = raw.map { it.substringAfterLast('/') }
            val flags = flagLetters(raw)

            if (commands.contains("rm") && flags.contains('r')) codes.add(DangerCode.RECURSIVE_DELETE)
            if (commands.any { it == "mkfs" || it.startsWith("mkfs.") } ||
                commands.contains("fdisk") ||
                commands.contains("parted") ||
                commands.contains("mkswap")
            ) {
                codes.add(DangerCode.FILESYSTEM_FORMAT)
            }
            // dd is only dangerous when it is writing somewhere; dd with no of= is a read.
            if (commands.contains("dd") && raw.any { it.startsWith("of=") }) {
                codes.add(DangerCode.RAW_DISK_WRITE)
            }
            if (commands.any { it in POWER_COMMANDS }) codes.add(DangerCode.POWER_STATE)
            if (commands.contains("history") && flags.contains('c')) codes.add(DangerCode.HISTORY_WIPE)
            if (commands.contains("rm") && raw.any { it.endsWith("_history") || it.endsWith(".bash_history") }) {
                codes.add(DangerCode.HISTORY_WIPE)
            }
            if ((commands.contains("chmod") || commands.contains("chown")) &&
                raw.any { it in CRITICAL_PATHS || it == "/" }
            ) {
                codes.add(DangerCode.PERMISSION_RESET)
            }
            // 777 on anything is a permission reset worth a second look even without a critical path.
            if (commands.contains("chmod") && raw.any { it == "777" || it == "-R" && flags.contains('r') }) {
                if (raw.contains("777")) codes.add(DangerCode.PERMISSION_RESET)
            }
        }

        // These two are properties of the whole pipeline rather than of any one segment, so they are
        // matched against the joined command after whitespace is removed.
        val squeezed = command.filterNot { it.isWhitespace() }
        if (squeezed.contains(":(){")) codes.add(DangerCode.FORK_BOMB)
        if (command.contains('|')) {
            val downloads = segments.any { segment ->
                rawWords(segment).map { it.substringAfterLast('/') }.any { it in DOWNLOADERS }
            }
            val shells = segments.any { segment ->
                rawWords(segment).map { it.substringAfterLast('/') }.any { it in SHELLS }
            }
            if (downloads && shells) codes.add(DangerCode.PIPE_DOWNLOAD_TO_SHELL)
        }

        // A redirect onto a device node or a boot/auth file destroys the target regardless of the
        // command producing the bytes, so it is matched on the redirect target itself.
        if (command.contains('>')) {
            val targets = command.split('>').drop(1).map { it.trim().substringBefore(' ') }
            if (targets.any { target -> target in CRITICAL_PATHS || DEVICE_PREFIXES.any { target.startsWith(it) } }) {
                codes.add(DangerCode.CRITICAL_PATH_OVERWRITE)
            }
        }

        // sudo on its own is far too common to flag. It is only reported once something else in the
        // command already earned a prompt, or when it is used to open an interactive root shell,
        // because those are the cases where the elevation is the thing that makes it dangerous.
        val elevated = segmentsOf(command).any { segment ->
            val commands = rawWords(segment).map { it.substringAfterLast('/') }
            val head = commands.firstOrNull()
            head in ELEVATORS && (codes.isNotEmpty() || commands.drop(1).any { it in SHELLS || it == "-i" || it == "-s" })
        }
        if (elevated) codes.add(DangerCode.PRIVILEGE_ESCALATION)

        return codes
    }

    /**
     * Splits on shell separators.
     *
     * Per-segment matching is what stops "echo rm -rf" from being read as a delete: the words that
     * matter are the ones in command position of their own segment.
     */
    fun segmentsOf(command: String): List<String> =
        command.split(";", "&&", "||", "|", "\n")
            .map { it.trim() }
            .filter { it.isNotEmpty() }

    private fun rawWords(segment: String): List<String> =
        segment.split(' ', '\t')
            .map { it.trim().trim('"', '\'', '(', ')') }
            .filter { it.isNotEmpty() }

    /**
     * Letters from short flag clusters, with the long spellings folded onto the same letter.
     *
     * -rf, -fr, -r -f and --recursive all mean the same thing to the user and must all trip the
     * recursive-delete check; reading only "-rf" would miss three of the four.
     */
    private fun flagLetters(words: List<String>): Set<Char> {
        val letters = HashSet<Char>()
        for (word in words) {
            if (word.startsWith("--")) {
                when (word.removePrefix("--").lowercase()) {
                    "recursive" -> letters.add('r')
                    "force" -> letters.add('f')
                    "no-preserve-root" -> letters.add('r')
                    else -> Unit
                }
            } else if (word.length > 1 && word.startsWith("-")) {
                for (character in word.substring(1)) letters.add(character.lowercaseChar())
            }
        }
        return letters
    }

    private val POWER_COMMANDS = setOf("shutdown", "reboot", "halt", "poweroff")
    private val DOWNLOADERS = setOf("curl", "wget", "fetch")
    private val SHELLS = setOf("sh", "bash", "zsh", "dash", "ksh", "python", "python3", "perl", "ruby")
    private val ELEVATORS = setOf("sudo", "doas", "su", "pkexec")
    private val DEVICE_PREFIXES = listOf("/dev/sd", "/dev/nvme", "/dev/hd", "/dev/vd", "/dev/mmcblk")
    private val CRITICAL_PATHS = setOf(
        "/",
        "/etc",
        "/etc/passwd",
        "/etc/shadow",
        "/etc/fstab",
        "/etc/sudoers",
        "/boot",
        "/usr",
        "/var",
    )
}
