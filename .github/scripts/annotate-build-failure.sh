#!/usr/bin/env bash
#
# Re-emit a failed build's diagnostics as GitHub check-run annotations.
#
# Why this exists: a failing compile step is publicly visible only as "Process
# completed with exit code 1". Job LOGS require an authenticated token, but
# ANNOTATIONS are readable from the public check-runs API and render inline in
# the PR UI. A build that fails without annotating itself is a build whose cause
# can only be read by someone holding repo credentials.
#
# Usage: annotate-build-failure.sh <logfile> <label>
#
# Never changes the outcome: the caller keeps the original exit status. This
# script only prints and always exits 0, so a formatting bug here cannot mask a
# real failure or turn a red build green.

set -uo pipefail

log="${1:-}"
label="${2:-build}"

if [ -z "$log" ] || [ ! -f "$log" ]; then
  echo "::error title=${label}::failed, and no log file was captured at '${log}'"
  exit 0
fi

# Strip ANSI colour and CR so annotation bodies are readable and workflow
# commands are not corrupted by carriage returns.
clean=$(mktemp)
sed -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' -e 's/\r$//' "$log" > "$clean"

# Emit one annotation, escaping what GitHub treats specially inside a workflow
# command. Capped well under the annotation length limit: an earlier run was
# truncated mid-word, which loses exactly the line you needed.
emit() {
  local title="$1"
  local text="$2"
  [ -z "$text" ] && return 0
  text=$(printf '%s' "$text" | head -c 2600)
  local esc=${text//'%'/'%25'}
  esc=${esc//$'\r'/}
  esc=${esc//$'\n'/'%0A'}
  echo "::error title=${title}::${esc}"
}

# ---- the cause regions, which the toolchains delimit for us ----------------
#
# cargo: the build script's stdout is printed in full first, and this project's
# build.rs emits several hundred `cargo:rerun-if-changed=` lines, so the panic is
# only findable by cutting at `--- stderr`.
if grep -q '^  *--- stderr' "$clean"; then
  emit "${label}: build script stderr" "$(sed -n '/^ *--- stderr/,$p' "$clean" | head -n 40)"
fi

# gradle: `* What went wrong:` names the failing task and the cause; `* Try:`
# begins the boilerplate. With --stacktrace the frames follow, and there are
# hundreds of them, so the region has to be bounded on both sides.
if grep -q '^\* What went wrong:' "$clean"; then
  emit "${label}: what went wrong" \
    "$(sed -n '/^\* What went wrong:/,/^\* Try:/p' "$clean" | head -n 40)"
fi

# `Caused by:` chains carry the root reason for both Gradle and cargo.
if grep -q '^Caused by:' "$clean"; then
  emit "${label}: caused by" "$(grep -A 4 '^Caused by:' "$clean" | head -n 30)"
fi

# ---- individual compiler diagnostics --------------------------------------
#
# One annotation per diagnostic so each lands on its own line in the UI. Stack
# frames and the rerun-if-changed flood are dropped first, or they crowd out the
# lines that matter.
signal=$(mktemp)
grep -v -e '^cargo:rerun-if-changed=' -e '^[[:space:]]*at [a-zA-Z]' -e '^cargo:rustc-' "$clean" > "$signal"

matched=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  emit "$label" "$line"
  matched=$((matched + 1))
  [ "$matched" -ge 25 ] && break
done < <(grep -E \
  -e '^e: ' \
  -e ': error: ' \
  -e '(^|[[:space:]])error(\[[A-Z0-9]+\])?:' \
  -e 'panicked at' \
  -e 'Unresolved reference' \
  -e 'Compilation error' \
  -e 'Could not (find|resolve|determine)' \
  -e 'No such file or directory' \
  "$signal" | head -n 25)

# Nothing recognised: fall back to the de-noised tail, which is far more useful
# than the raw tail for exactly the reason this rewrite exists.
if [ "$matched" -eq 0 ]; then
  emit "${label} (no diagnostic matched; de-noised tail)" "$(tail -n 30 "$signal")"
fi

# The run summary renders multi-line text properly and is likewise public.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ${label} failed"
    echo
    echo '```'
    tail -n 200 "$signal"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

rm -f "$clean" "$signal"
exit 0
