#!/usr/bin/env bash
#
# Re-emit a failed build's diagnostics as GitHub check-run annotations.
#
# Why this exists: a failing compile step is publicly visible only as "Process
# completed with exit code 1". Job LOGS require an authenticated token, but
# ANNOTATIONS are readable from the public check-runs API and are shown inline in
# the PR UI. So a build that fails without annotating itself is a build whose
# cause can only be read by someone holding repo credentials -- and the android
# and ios jobs sat failing for a day for exactly that reason.
#
# Usage: annotate-build-failure.sh <logfile> <label>
#
# Never changes the outcome: the caller keeps the original exit status. This
# script only prints, and exits 0 so a formatting problem here cannot mask the
# real failure or, worse, turn a red build green.

set -uo pipefail

log="${1:-}"
label="${2:-build}"

if [ -z "$log" ] || [ ! -f "$log" ]; then
  echo "::error title=${label}::failed, and no log file was captured at '${log}'"
  exit 0
fi

# Strip ANSI colour so the annotation body is readable, and strip CR so Windows
# runners do not embed carriage returns into the workflow command.
clean=$(mktemp)
sed -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' -e 's/\r$//' "$log" > "$clean"

# The compiler lines worth surfacing. Kotlin and Swift both emit
# `path:line:col: error: message`; Gradle adds `e: file://...` and its own
# `FAILURE:` / `* What went wrong:` blocks; cargo/rustc use `error[E0308]:`.
matched=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # GitHub treats %, CR and LF specially inside a workflow command.
  esc=${line//'%'/'%25'}
  esc=${esc//$'\r'/}
  esc=${esc//$'\n'/'%0A'}
  echo "::error title=${label}::${esc}"
  matched=$((matched + 1))
  [ "$matched" -ge 40 ] && break
done < <(grep -E -e '^e: ' -e '(^|[[:space:]])error(\[[A-Z0-9]+\])?:' -e ': error: ' -e '^FAILURE: ' -e '^\* What went wrong:' -e 'Compilation error' -e 'Unresolved reference' -e 'cannot find' -e "panicked at" -e '^--- stderr' -e '^Caused by:' -e '^\s+> ' -e 'Could not (find|resolve|determine)' -e 'No such file or directory' "$clean" | head -n 40)

# The tail is emitted ALWAYS, not only when nothing matched.
#
# Selectivity is what hid the first real answer: cargo printed
#   error: failed to run custom build command for `zephyr-one ...`
# which matched the filter, so the tail was suppressed -- but the actual cause
# is in the lines cargo prints after it (`--- stderr`, `thread 'main' panicked
# at ...`, then the message), none of which contain `error:`. Gradle behaves the
# same way: `* What went wrong:` matches and the cause is the line beneath it.
# A matched diagnostic names the category; the tail is what names the cause.
tail_text=$(tail -n 60 "$clean")
esc=${tail_text//'%'/'%25'}
esc=${esc//$'\r'/}
esc=${esc//$'\n'/'%0A'}
if [ "$matched" -eq 0 ]; then
  echo "::error title=${label} (no diagnostic matched; last 60 lines)::${esc}"
else
  echo "::error title=${label} (last 60 lines)::${esc}"
fi

# Also drop the tail into the run summary, which renders multi-line text far
# better than an annotation and is likewise public.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ${label} failed"
    echo
    echo '```'
    tail -n 120 "$clean"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

rm -f "$clean"
exit 0
