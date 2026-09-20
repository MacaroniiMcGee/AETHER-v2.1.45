#!/bin/bash
#
# IOplus Loopback Test (Bash version)
# Tests relay outputs AND opto inputs simultaneously
#
# WIRING: Connect each relay output to corresponding opto input
#

SERVER="${1:-http://127.0.0.1:3001}"
CYCLES="${2:-50}"
DELAY="${3:-0.1}"        # 100ms between operations
SETTLE="${4:-0.03}"      # 30ms relay settle time

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Stats
TOTAL_TESTS=0
RELAY_SUCCESS=0
RELAY_FAILED=0
INPUT_SUCCESS=0
INPUT_FAILED=0
LOOPBACK_MATCH=0
LOOPBACK_MISMATCH=0
TIMEOUTS=0

# Log
LOG_FILE="loopback-$(date +%Y%m%d-%H%M%S).log"
ERRORS=()

log() {
    echo -e "$1"
    echo "$(date '+%H:%M:%S.%3N') $1" | sed 's/\x1b\[[0-9;]*m//g' >> "$LOG_FILE"
}

set_relay() {
    local pin=$1
    local state=$2
    local response
    
    response=$(curl -s --max-time 2 -X POST "$SERVER/api/gpio/set" \
        -H "Content-Type: application/json" \
        -d "{\"pin\":$pin,\"value\":$state}" 2>/dev/null)
    
    if [ -z "$response" ]; then
        TIMEOUTS=$((TIMEOUTS + 1))
        return 1
    fi
    
    if echo "$response" | grep -q '"success":true'; then
        RELAY_SUCCESS=$((RELAY_SUCCESS + 1))
        return 0
    else
        RELAY_FAILED=$((RELAY_FAILED + 1))
        return 1
    fi
}

read_input() {
    local pin=$1
    local response
    
    response=$(curl -s --max-time 2 "$SERVER/api/gpio/input/$pin" 2>/dev/null)
    
    if [ -z "$response" ]; then
        TIMEOUTS=$((TIMEOUTS + 1))
        echo "-1"
        return 1
    fi
    
    if echo "$response" | grep -q '"success":true'; then
        INPUT_SUCCESS=$((INPUT_SUCCESS + 1))
        # Extract state value
        echo "$response" | grep -o '"state":[0-9]*' | head -1 | cut -d':' -f2
        return 0
    else
        INPUT_FAILED=$((INPUT_FAILED + 1))
        echo "-1"
        return 1
    fi
}

read_all_inputs() {
    curl -s --max-time 2 "$SERVER/api/gpio/inputs" 2>/dev/null
}

read_all_relays() {
    curl -s --max-time 2 "$SERVER/api/gpio/relays" 2>/dev/null
}

check_health() {
    local response=$(curl -s --max-time 2 "$SERVER/api/health" 2>/dev/null)
    if [ -z "$response" ]; then
        echo "OFFLINE"
        return 1
    fi
    
    local healthy=$(echo "$response" | grep -o '"boardHealthy":[^,}]*' | cut -d':' -f2)
    local mode=$(echo "$response" | grep -o '"ioplusMode":"[^"]*"' | cut -d'"' -f4)
    
    if [ "$healthy" = "false" ]; then
        echo "UNHEALTHY"
        return 1
    fi
    
    echo "OK ($mode)"
    return 0
}

test_loopback() {
    local relay_pin=$1
    local input_pin=$2
    local expected_state=$3
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    # Set relay
    if ! set_relay "$relay_pin" "$expected_state"; then
        ERRORS+=("Relay $relay_pin set to $expected_state FAILED")
        return 1
    fi
    
    # Wait for relay to settle
    sleep "$SETTLE"
    
    # Read input
    local actual_state=$(read_input "$input_pin")
    
    if [ "$actual_state" = "-1" ]; then
        ERRORS+=("Input $input_pin read FAILED")
        return 1
    fi
    
    # Check match
    if [ "$actual_state" = "$expected_state" ]; then
        LOOPBACK_MATCH=$((LOOPBACK_MATCH + 1))
        return 0
    else
        LOOPBACK_MISMATCH=$((LOOPBACK_MISMATCH + 1))
        ERRORS+=("MISMATCH: Relay $relay_pin=$expected_state, Input $input_pin=$actual_state")
        return 1
    fi
}

# Header
echo ""
log "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
log "${CYAN}  IOplus Loopback Test (Bash)${NC}"
log "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
log "  Server:    $SERVER"
log "  Cycles:    $CYCLES"
log "  Delay:     ${DELAY}s"
log "  Settle:    ${SETTLE}s"
log "  Log:       $LOG_FILE"
log "  Mapping:   Relay 0-7 → Input 0-7 (1:1)"
log "${CYAN}───────────────────────────────────────────────────────────────${NC}"
echo ""

# Health check
log "${YELLOW}[PRE-TEST]${NC} Checking server health..."
HEALTH=$(check_health)
if echo "$HEALTH" | grep -q "OFFLINE\|UNHEALTHY"; then
    log "${RED}[ERROR]${NC} Server not healthy: $HEALTH"
    exit 1
fi
log "${GREEN}[OK]${NC} Server: $HEALTH"

# Initial state
log "${YELLOW}[PRE-TEST]${NC} Initial states..."
INIT_RELAYS=$(read_all_relays)
INIT_INPUTS=$(read_all_inputs)
log "  Relays: $(echo $INIT_RELAYS | grep -o '"state":[0-9]' | cut -d':' -f2 | tr '\n' ' ')"
log "  Inputs: $(echo $INIT_INPUTS | grep -o '"state":[0-9]' | cut -d':' -f2 | tr '\n' ' ')"
echo ""

log "${YELLOW}[STARTING]${NC} Running $CYCLES cycles..."
log "${CYAN}───────────────────────────────────────────────────────────────${NC}"

START_TIME=$(date +%s.%N)

for ((cycle=1; cycle<=CYCLES; cycle++)); do
    # Progress
    if [ $((cycle % 10)) -eq 0 ] || [ $cycle -eq 1 ]; then
        PCT=$(echo "scale=1; $LOOPBACK_MATCH * 100 / ($TOTAL_TESTS + 1)" | bc 2>/dev/null || echo "0")
        printf "\r${CYAN}[Cycle %3d/%d]${NC} Match:%d Mismatch:%d | RelayOK:%d InputOK:%d | %s%%   " \
            $cycle $CYCLES $LOOPBACK_MATCH $LOOPBACK_MISMATCH $RELAY_SUCCESS $INPUT_SUCCESS "$PCT"
    fi
    
    # Test each relay→input pair (0-7)
    for pin in 0 1 2 3 4 5 6 7; do
        # ON test
        test_loopback $pin $pin 1
        sleep "$DELAY"
        
        # OFF test  
        test_loopback $pin $pin 0
        sleep "$DELAY"
    done
    
    # Health check every 10 cycles
    if [ $((cycle % 10)) -eq 0 ]; then
        HEALTH=$(check_health)
        if echo "$HEALTH" | grep -q "OFFLINE\|UNHEALTHY"; then
            echo ""
            log "${RED}[ALERT]${NC} Board unhealthy at cycle $cycle!"
            log "${YELLOW}[WAIT]${NC} Pausing 2 seconds..."
            sleep 2
            HEALTH=$(check_health)
            if echo "$HEALTH" | grep -q "OFFLINE\|UNHEALTHY"; then
                log "${RED}[FATAL]${NC} Still unhealthy - aborting"
                break
            fi
        fi
    fi
done

END_TIME=$(date +%s.%N)
DURATION=$(echo "$END_TIME - $START_TIME" | bc)
SUCCESS_RATE=$(echo "scale=1; $LOOPBACK_MATCH * 100 / $TOTAL_TESTS" | bc 2>/dev/null || echo "0")

echo ""
echo ""
log "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
log "${CYAN}  LOOPBACK TEST RESULTS${NC}"
log "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
log "  ${CYAN}Total Tests:${NC}       $TOTAL_TESTS"
log "  ${GREEN}Loopback Match:${NC}    $LOOPBACK_MATCH"
log "  ${RED}Loopback Mismatch:${NC} $LOOPBACK_MISMATCH"
echo ""
log "  ${GREEN}Relay Success:${NC}     $RELAY_SUCCESS"
log "  ${RED}Relay Failed:${NC}      $RELAY_FAILED"
log "  ${GREEN}Input Success:${NC}     $INPUT_SUCCESS"
log "  ${RED}Input Failed:${NC}      $INPUT_FAILED"
echo ""
log "  ${YELLOW}Timeouts:${NC}          $TIMEOUTS"
log "  Duration:          ${DURATION}s"
log "  Success Rate:      ${SUCCESS_RATE}%"
echo ""

# Final state
FINAL_RELAYS=$(read_all_relays)
FINAL_INPUTS=$(read_all_inputs)
log "  Final Relays: $(echo $FINAL_RELAYS | grep -o '"state":[0-9]' | cut -d':' -f2 | tr '\n' ' ')"
log "  Final Inputs: $(echo $FINAL_INPUTS | grep -o '"state":[0-9]' | cut -d':' -f2 | tr '\n' ' ')"

# Show errors
if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    log "${RED}  Errors (first 10):${NC}"
    for i in "${!ERRORS[@]}"; do
        [ $i -ge 10 ] && break
        log "    - ${ERRORS[$i]}"
    done
fi

echo ""
if [ $LOOPBACK_MISMATCH -eq 0 ] && [ $RELAY_FAILED -eq 0 ] && [ $INPUT_FAILED -eq 0 ]; then
    log "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    log "${GREEN}  ✓ ALL LOOPBACK TESTS PASSED - ${SUCCESS_RATE}% SUCCESS${NC}"
    log "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    exit 0
else
    log "${RED}═══════════════════════════════════════════════════════════════${NC}"
    log "${RED}  ✗ LOOPBACK FAILURES DETECTED${NC}"
    log "${RED}═══════════════════════════════════════════════════════════════${NC}"
    exit 1
fi
