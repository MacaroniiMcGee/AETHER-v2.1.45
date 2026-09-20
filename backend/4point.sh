#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# 4-POINT SUPERVISION CALIBRATION TOOL
# For Aether IOplus - 1K/2K EOL (No Reference Resistor)
# ═══════════════════════════════════════════════════════════════════════════════

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
BOLD='\033[1m'
NC='\033[0m'

# Config
BOARD=0
CHANNEL=1
SAMPLES=5
CONFIG_FILE="supervision-calibration.json"

# ═══════════════════════════════════════════════════════════════════════════════
clear
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${WHITE}${BOLD}       4-POINT SUPERVISION CALIBRATION TOOL v1.0                          ${NC}${CYAN}║${NC}"
echo -e "${CYAN}║${NC}       For IOplus 1K/2K EOL - No Reference Resistor                        ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# FUNCTION: Read ADC with averaging
# ═══════════════════════════════════════════════════════════════════════════════
read_adc() {
    local board=$1
    local channel=$2
    local samples=${3:-5}
    local total=0
    local count=0
    
    for ((i=1; i<=samples; i++)); do
        # IOplus ADC is 1-indexed
        local reading=$(ioplus $board adcrd $channel 2>/dev/null)
        if [[ $reading =~ ^-?[0-9]+\.?[0-9]*$ ]]; then
            total=$(echo "$total + $reading" | bc -l)
            ((count++))
        fi
        sleep 0.1
    done
    
    if [ $count -gt 0 ]; then
        echo "scale=4; $total / $count" | bc -l
    else
        echo "ERROR"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# SELECT BOARD AND CHANNEL
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}Select ADC to calibrate:${NC}"
echo -ne "  Board [0-3] (default 0): "
read -r input_board
BOARD=${input_board:-0}

echo -ne "  Channel [1-8] (default 1): "
read -r input_channel
CHANNEL=${input_channel:-1}

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${WHITE}${BOLD}  Calibrating Board $BOARD, Channel $CHANNEL${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# TEST ADC CONNECTION
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}Testing ADC connection...${NC}"
test_reading=$(ioplus $BOARD adcrd $CHANNEL 2>&1)

if [[ $test_reading == *"Error"* ]] || [[ $test_reading == *"No IOplus"* ]] || [[ $test_reading == *"fail"* ]]; then
    echo -e "${RED}✗ ERROR: Cannot read from IOplus board $BOARD!${NC}"
    echo -e "  Response: $test_reading"
    echo ""
    echo -e "  Check:"
    echo -e "    - Is the IOplus board connected?"
    echo -e "    - Is I2C enabled? (sudo raspi-config)"
    echo -e "    - Run: i2cdetect -y 1"
    exit 1
fi

echo -e "${GREEN}✓ ADC responding: ${WHITE}${test_reading}V${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# 4-POINT CALIBRATION
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${WHITE}${BOLD}We will measure 4 states:${NC}"
echo -e "  1. ${RED}TAMPER${NC}  - Wires shorted together (bypass resistors)"
echo -e "  2. ${YELLOW}ALARM${NC}   - Sensor triggered (contact open)"
echo -e "  3. ${GREEN}NORMAL${NC}  - Sensor closed (secured state)"
echo -e "  4. ${BLUE}TROUBLE${NC} - Wire cut / disconnected"
echo ""

declare -A voltages

# ───────────────────────────────────────────────────────────────────────────────
# STATE 1: TAMPER (Shorted)
# ───────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${RED}${BOLD}STATE 1: TAMPER (Short Circuit)${NC}"
echo -e "${CYAN}───────────────────────────────────────────────────────────────────────────${NC}"
echo -e "Short the wires together at the sensor (bypass all resistors)."
echo -e "This simulates tampering/cover removal."
echo ""
echo -ne "Press ${WHITE}[ENTER]${NC} when ready..."
read -r

echo -e "${YELLOW}Reading... (averaging $SAMPLES samples)${NC}"
TAMPER_V=$(read_adc $BOARD $CHANNEL $SAMPLES)
if [[ "$TAMPER_V" == "ERROR" ]]; then
    echo -e "${RED}✗ Failed to read ADC${NC}"
    exit 1
fi
voltages["TAMPER"]=$TAMPER_V
TAMPER_MV=$(echo "scale=0; $TAMPER_V * 1000 / 1" | bc)
echo -e "${RED}✓ TAMPER: ${WHITE}${BOLD}${TAMPER_V}V${NC} ${RED}(${TAMPER_MV}mV)${NC}"
echo ""

# ───────────────────────────────────────────────────────────────────────────────
# STATE 2: ALARM (Sensor Triggered)
# ───────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}${BOLD}STATE 2: ALARM (Sensor Triggered)${NC}"
echo -e "${CYAN}───────────────────────────────────────────────────────────────────────────${NC}"
echo -e "Open the sensor contact (trigger the alarm)."
echo -e "The 1K alarm resistor should be in circuit."
echo ""
echo -ne "Press ${WHITE}[ENTER]${NC} when ready..."
read -r

echo -e "${YELLOW}Reading...${NC}"
ALARM_V=$(read_adc $BOARD $CHANNEL $SAMPLES)
if [[ "$ALARM_V" == "ERROR" ]]; then
    echo -e "${RED}✗ Failed to read ADC${NC}"
    exit 1
fi
voltages["ALARM"]=$ALARM_V
ALARM_MV=$(echo "scale=0; $ALARM_V * 1000 / 1" | bc)
echo -e "${YELLOW}✓ ALARM: ${WHITE}${BOLD}${ALARM_V}V${NC} ${YELLOW}(${ALARM_MV}mV)${NC}"
echo ""

# ───────────────────────────────────────────────────────────────────────────────
# STATE 3: NORMAL (Sensor Closed/Secured)
# ───────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}STATE 3: NORMAL (Sensor Closed/Secured)${NC}"
echo -e "${CYAN}───────────────────────────────────────────────────────────────────────────${NC}"
echo -e "Close the sensor contact (secured state)."
echo -e "Current flows through EOL resistor and closed contact."
echo ""
echo -ne "Press ${WHITE}[ENTER]${NC} when ready..."
read -r

echo -e "${YELLOW}Reading...${NC}"
NORMAL_V=$(read_adc $BOARD $CHANNEL $SAMPLES)
if [[ "$NORMAL_V" == "ERROR" ]]; then
    echo -e "${RED}✗ Failed to read ADC${NC}"
    exit 1
fi
voltages["NORMAL"]=$NORMAL_V
NORMAL_MV=$(echo "scale=0; $NORMAL_V * 1000 / 1" | bc)
echo -e "${GREEN}✓ NORMAL: ${WHITE}${BOLD}${NORMAL_V}V${NC} ${GREEN}(${NORMAL_MV}mV)${NC}"
echo ""

# ───────────────────────────────────────────────────────────────────────────────
# STATE 4: TROUBLE (Wire Cut/Open)
# ───────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}${BOLD}STATE 4: TROUBLE (Wire Cut/Open Circuit)${NC}"
echo -e "${CYAN}───────────────────────────────────────────────────────────────────────────${NC}"
echo -e "Disconnect the wire completely (simulate wire cut)."
echo -e "No current path - ADC sees floating/pulled voltage."
echo ""
echo -ne "Press ${WHITE}[ENTER]${NC} when ready..."
read -r

echo -e "${YELLOW}Reading...${NC}"
TROUBLE_V=$(read_adc $BOARD $CHANNEL $SAMPLES)
if [[ "$TROUBLE_V" == "ERROR" ]]; then
    echo -e "${RED}✗ Failed to read ADC${NC}"
    exit 1
fi
voltages["TROUBLE"]=$TROUBLE_V
TROUBLE_MV=$(echo "scale=0; $TROUBLE_V * 1000 / 1" | bc)
echo -e "${BLUE}✓ TROUBLE: ${WHITE}${BOLD}${TROUBLE_V}V${NC} ${BLUE}(${TROUBLE_MV}mV)${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# CALCULATE THRESHOLDS
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${WHITE}${BOLD}                    CALIBRATION RESULTS                                   ${NC}${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${WHITE}${BOLD}Measured Voltages:${NC}"
echo -e "  ┌─────────────┬────────────┬────────────┐"
echo -e "  │ State       │ Volts      │ Millivolts │"
echo -e "  ├─────────────┼────────────┼────────────┤"
printf "  │ ${RED}TAMPER${NC}      │ %8.3fV  │ %6dmV   │\n" "$TAMPER_V" "$TAMPER_MV"
printf "  │ ${YELLOW}ALARM${NC}       │ %8.3fV  │ %6dmV   │\n" "$ALARM_V" "$ALARM_MV"
printf "  │ ${GREEN}NORMAL${NC}      │ %8.3fV  │ %6dmV   │\n" "$NORMAL_V" "$NORMAL_MV"
printf "  │ ${BLUE}TROUBLE${NC}     │ %8.3fV  │ %6dmV   │\n" "$TROUBLE_V" "$TROUBLE_MV"
echo -e "  └─────────────┴────────────┴────────────┘"
echo ""

# Calculate threshold boundaries (midpoints with margins)
# Sort values and create ranges

# Add 20% margin around each measurement
TAMPER_MIN=0
TAMPER_MAX=$(echo "scale=0; $TAMPER_MV + ($ALARM_MV - $TAMPER_MV) / 2" | bc)

ALARM_MIN=$((TAMPER_MAX + 1))
ALARM_MAX=$(echo "scale=0; $ALARM_MV + ($NORMAL_MV - $ALARM_MV) / 2" | bc)

NORMAL_MIN=$((ALARM_MAX + 1))
NORMAL_MAX=$(echo "scale=0; $NORMAL_MV + ($TROUBLE_MV - $NORMAL_MV) / 3" | bc)

TROUBLE_MIN=$((NORMAL_MAX + 1))
TROUBLE_MAX=3500

echo -e "${WHITE}${BOLD}Calculated Thresholds (millivolts):${NC}"
echo -e "  ┌─────────────┬────────────┬────────────┐"
echo -e "  │ State       │ Min (mV)   │ Max (mV)   │"
echo -e "  ├─────────────┼────────────┼────────────┤"
printf "  │ ${RED}TAMPER${NC}      │ %6d     │ %6d     │\n" "$TAMPER_MIN" "$TAMPER_MAX"
printf "  │ ${YELLOW}ALARM${NC}       │ %6d     │ %6d     │\n" "$ALARM_MIN" "$ALARM_MAX"
printf "  │ ${GREEN}NORMAL${NC}      │ %6d     │ %6d     │\n" "$NORMAL_MIN" "$NORMAL_MAX"
printf "  │ ${BLUE}TROUBLE${NC}     │ %6d     │ %6d     │\n" "$TROUBLE_MIN" "$TROUBLE_MAX"
echo -e "  └─────────────┴────────────┴────────────┘"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# OUTPUT JAVASCRIPT CONFIG
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${WHITE}${BOLD}JavaScript Configuration:${NC}"
echo -e "${CYAN}───────────────────────────────────────────────────────────────────────────${NC}"
echo ""
echo -e "${GREEN}// Add to supervisionController.js constructor:${NC}"
echo -e "${CYAN}this.thresholds = {"
echo -e "  // Calibrated: $(date '+%Y-%m-%d %H:%M')"
echo -e "  // Board: $BOARD, Channel: $CHANNEL"
echo -e "  "
echo -e "  // TAMPER: Short circuit (${TAMPER_V}V measured)"
echo -e "  tamperMin: $TAMPER_MIN,"
echo -e "  tamperMax: $TAMPER_MAX,"
echo -e "  "
echo -e "  // ALARM: Sensor triggered (${ALARM_V}V measured)"
echo -e "  alarmMin: $ALARM_MIN,"
echo -e "  alarmMax: $ALARM_MAX,"
echo -e "  "
echo -e "  // NORMAL: Closed/secured (${NORMAL_V}V measured)"
echo -e "  normalMin: $NORMAL_MIN,"
echo -e "  normalMax: $NORMAL_MAX,"
echo -e "  "
echo -e "  // TROUBLE: Open/wire cut (${TROUBLE_V}V measured)"
echo -e "  troubleMin: $TROUBLE_MIN,"
echo -e "  troubleMax: $TROUBLE_MAX"
echo -e "};${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# SAVE TO JSON FILE
# ═══════════════════════════════════════════════════════════════════════════════
cat > "$CONFIG_FILE" << EOF
{
  "calibrationDate": "$(date -Iseconds)",
  "board": $BOARD,
  "channel": $CHANNEL,
  "measurements": {
    "TAMPER":  { "volts": $TAMPER_V, "millivolts": $TAMPER_MV },
    "ALARM":   { "volts": $ALARM_V, "millivolts": $ALARM_MV },
    "NORMAL":  { "volts": $NORMAL_V, "millivolts": $NORMAL_MV },
    "TROUBLE": { "volts": $TROUBLE_V, "millivolts": $TROUBLE_MV }
  },
  "thresholds": {
    "tamperMin": $TAMPER_MIN,
    "tamperMax": $TAMPER_MAX,
    "alarmMin": $ALARM_MIN,
    "alarmMax": $ALARM_MAX,
    "normalMin": $NORMAL_MIN,
    "normalMax": $NORMAL_MAX,
    "troubleMin": $TROUBLE_MIN,
    "troubleMax": $TROUBLE_MAX
  }
}
EOF

echo -e "${GREEN}✓ Configuration saved to: ${WHITE}${CONFIG_FILE}${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# LIVE TEST MODE
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${CYAN}═══════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${WHITE}${BOLD}LIVE TEST MODE${NC}"
echo -e "${CYAN}───────────────────────────────────────────────────────────────────────────${NC}"
echo -ne "Press ${WHITE}[ENTER]${NC} to start live monitoring, or ${WHITE}[q]${NC} to quit: "
read -r input

if [[ "$input" == "q" || "$input" == "Q" ]]; then
    echo ""
    echo -e "${GREEN}✓ Calibration complete!${NC}"
    echo -e "  Copy the thresholds above into your supervisionController.js"
    exit 0
fi

echo ""
echo -e "${WHITE}Live monitoring Board $BOARD, Channel $CHANNEL...${NC}"
echo -e "${WHITE}Press Ctrl+C to stop${NC}"
echo ""

while true; do
    reading=$(ioplus $BOARD adcrd $CHANNEL 2>/dev/null)
    if [[ $reading =~ ^-?[0-9]+\.?[0-9]*$ ]]; then
        mv=$(echo "scale=0; $reading * 1000 / 1" | bc)
        
        # Determine state
        state="UNKNOWN"
        color=$WHITE
        
        if (( mv <= TAMPER_MAX )); then
            state="TAMPER"
            color=$RED
        elif (( mv >= ALARM_MIN && mv <= ALARM_MAX )); then
            state="ALARM"
            color=$YELLOW
        elif (( mv >= NORMAL_MIN && mv <= NORMAL_MAX )); then
            state="NORMAL"
            color=$GREEN
        elif (( mv >= TROUBLE_MIN )); then
            state="TROUBLE"
            color=$BLUE
        fi
        
        printf "\r  Voltage: ${WHITE}${BOLD}%7.3fV${NC} (%5dmV)  │  State: ${color}${BOLD}%-8s${NC}   " "$reading" "$mv" "$state"
    else
        printf "\r  ${RED}Read error: %s${NC}                                    " "$reading"
    fi
    sleep 0.3
done
