#!/bin/bash
echo "=============================================="
echo "GPIO 5 & 6 Wiegand Troubleshooting"
echo "=============================================="

CHIP="gpiochip0"
[ -e /dev/gpiochip4 ] && CHIP="gpiochip4"
echo "Using: $CHIP"
echo ""

echo "1. GPIO Line Status (5, 6 vs 12, 13):"
gpioinfo $CHIP | grep -E "line\s+(5|6|12|13):"
echo ""

echo "2. Testing GPIO 5 write..."
gpioset -m time -u 100000 $CHIP 5=1 && echo "   ✓ GPIO 5 OK" || echo "   ✗ GPIO 5 FAILED"

echo "3. Testing GPIO 6 write..."
gpioset -m time -u 100000 $CHIP 6=1 && echo "   ✓ GPIO 6 OK" || echo "   ✗ GPIO 6 FAILED"
echo ""

echo "4. Pin functions (if pinctrl available):"
pinctrl get 5 2>/dev/null || echo "   pinctrl not available"
pinctrl get 6 2>/dev/null
pinctrl get 12 2>/dev/null
pinctrl get 13 2>/dev/null
echo ""

echo "5. Testing wiegand_tx binary..."
if [ -f ./bin/wiegand_tx ]; then
    echo "   Found: ./bin/wiegand_tx"
    ls -la ./bin/wiegand_tx
elif [ -f ./wiegand/wiegand_tx ]; then
    echo "   Found: ./wiegand/wiegand_tx"
    ls -la ./wiegand/wiegand_tx
else
    echo "   ✗ wiegand_tx not found in bin/ or wiegand/"
fi
