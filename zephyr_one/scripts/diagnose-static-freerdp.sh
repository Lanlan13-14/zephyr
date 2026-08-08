#!/usr/bin/env sh
# Report what the vcpkg static FreeRDP archives actually contain.
#
# Why this exists: a static-only triplet that links on the builder but leaves
# every FFI call undefined has three indistinguishable causes from the linker
# message alone — the archive is absent, the archive is a thin archive whose
# members were deleted by `--clean-after-build`, or the symbol genuinely lives
# in a different archive than the .pc file advertises. Guessing between them
# costs a full CI round trip each time, so print the facts instead.
#
# Read-only and never fails the job: it runs *before* the build so its output
# survives even when the build then dies.
set -u

LIBDIR="${1:-}"
if [ -z "$LIBDIR" ]; then
  echo "usage: diagnose-static-freerdp.sh <libdir>" >&2
  exit 2
fi

echo "=== archive inventory: $LIBDIR ==="
if [ ! -d "$LIBDIR" ]; then
  echo "MISSING DIRECTORY: $LIBDIR"
  exit 0
fi
ls -la "$LIBDIR" 2>/dev/null | head -60

echo
echo "=== per-archive membership and key symbols ==="
# gdi_free / freerdp_client_load_addins / EnterCriticalSection are one symbol
# from each of the three libraries, so a single run tells us whether the
# failure is library-wide or symbol-specific.
for base in freerdp3 freerdp-client3 winpr3; do
  a="$LIBDIR/lib$base.a"
  echo "--- lib$base.a ---"
  if [ ! -f "$a" ]; then
    echo "  ABSENT"
    continue
  fi
  echo "  size: $(wc -c < "$a" | tr -d ' ') bytes"
  # A thin archive stores paths, not object copies; its magic line differs.
  head -c 8 "$a" | od -c | head -1
  echo "  members (first 8):"
  ar t "$a" 2>&1 | head -8 | sed 's/^/    /'
  echo "  member count: $(ar t "$a" 2>/dev/null | wc -l | tr -d ' ')"
  echo "  defined-symbol count: $(nm --defined-only "$a" 2>/dev/null | wc -l | tr -d ' ')"
done

echo
echo "=== which archive defines each undefined symbol ==="
for sym in gdi_free freerdp_client_load_addins PubSub_Subscribe \
           freerdp_settings_set_bool EnterCriticalSection; do
  hit=""
  for a in "$LIBDIR"/lib*.a; do
    [ -f "$a" ] || continue
    if nm --defined-only "$a" 2>/dev/null | grep -q "[ ]$sym\$"; then
      hit="$hit $(basename "$a")"
    fi
  done
  if [ -n "$hit" ]; then
    echo "  $sym ->$hit"
  else
    echo "  $sym -> NOT DEFINED IN ANY ARCHIVE HERE"
  fi
done

echo
echo "=== pkg-config view (static) ==="
echo "PKG_CONFIG=${PKG_CONFIG:-<unset>}"
echo "PKG_CONFIG_PATH=${PKG_CONFIG_PATH:-<unset>}"
PC="${PKG_CONFIG:-pkg-config}"
for mod in freerdp3 freerdp-client3 winpr3; do
  echo "--- $mod ---"
  echo "  libs   : $("$PC" --libs --static "$mod" 2>&1)"
  echo "  libdirs: $("$PC" --variable=libdir "$mod" 2>&1)"
done
exit 0
