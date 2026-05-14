#!/usr/bin/env bash
# Triage a DICOM file that NeoDW failed to load.
#
# Runs dcm4che CLI tools to:
#   1. Show transfer syntax + key tags (dcmdump)
#   2. Validate against the IOD (dcmvalidate)
#   3. Re-encode to Explicit-VR Little-Endian and report path (dcm2dcm)
#
# If step 3's output loads in NeoDW but the original doesn't, the bug is
# in the codec / loader path — not the parser. That narrows the fix
# scope dramatically.
#
# Install dcm4che first:
#   https://sourceforge.net/projects/dcm4che/files/dcm4che3/
# Then add its bin/ directory to PATH.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <path/to/file.dcm>" >&2
  exit 2
fi

FILE="$1"
if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE" >&2
  exit 2
fi

for tool in dcmdump dcmvalidate dcm2dcm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install dcm4che and add bin/ to PATH." >&2
    echo "  https://sourceforge.net/projects/dcm4che/files/dcm4che3/" >&2
    exit 3
  fi
done

OUT_DIR="$(mktemp -d -t neodw-dcm-debug.XXXXXX)"
TRANSCODED="$OUT_DIR/$(basename "$FILE" .dcm)-explicit-le.dcm"

echo "==> dcmdump (header + first 50 lines)"
dcmdump "$FILE" | head -50 || true
echo

echo "==> dcmvalidate"
dcmvalidate "$FILE" || echo "(non-zero exit — file is non-conformant)"
echo

echo "==> dcm2dcm  →  Explicit-VR Little-Endian"
dcm2dcm -t 1.2.840.10008.1.2.1 "$FILE" "$TRANSCODED"
echo "Transcoded: $TRANSCODED"
echo
echo "Next: drop $TRANSCODED into NeoDW."
echo "  - Loads OK   →  bug is in the codec / pixel decode path"
echo "  - Still fails →  bug is in the dataset / parser path"
