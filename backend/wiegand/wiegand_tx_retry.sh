#!/bin/bash
# Retry wrapper - sends 5 times

D0=$1
D1=$2
FC=$3
CARD=$4
BITS=${5:-26}
PULSE=${6:-50}

for attempt in 1 2 3 4 5; do
  echo "[Attempt $attempt] FC=$FC Card=$CARD"
  sudo ./wiegand_tx $D0 $D1 $FC $CARD $BITS $PULSE
  sleep 0.5
done
echo "✓ Done"
