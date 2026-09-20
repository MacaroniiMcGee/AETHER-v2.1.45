# 🔌 API Quick Reference Card

## GPIO Endpoints

### Get System Status
```bash
GET /api/gpio/status
```
Returns: Complete GPIO system status (all relays and inputs)

### Health Check
```bash
GET /api/gpio/health
```
Returns: System health status

### Set Relay State
```bash
POST /api/gpio/set
Content-Type: application/json

{
  "pin": 0,      // Relay number (0-7)
  "state": 1     // 0=OFF, 1=ON
}
```

### Pulse Relay (Timed)
```bash
POST /api/gpio/pulse
Content-Type: application/json

{
  "pin": 0,           // Relay number (0-7)
  "duration": 3000    // Duration in ms
}
```
Common use: Door unlock (3000ms = 3 seconds)

### Get Relay State
```bash
GET /api/gpio/get/:pin
```
Example: `GET /api/gpio/get/0` (get state of relay 0)

### Read Digital Input
```bash
GET /api/gpio/input/:pin
```
Example: `GET /api/gpio/input/0` (read input 0)

### Emergency Shutdown
```bash
POST /api/gpio/emergency-shutdown
```
Turns off ALL relays immediately

---

## Supervision Endpoints

### Get Supervision Status
```bash
GET /api/supervision/status
```
Returns: Complete supervision status (all zones, all boards)

### Health Check
```bash
GET /api/supervision/health
```
Returns: Supervision system health

### Read Specific Zone
```bash
GET /api/supervision/zone/:board/:channel
```
Example: `GET /api/supervision/zone/0/1` (board 0, channel 1)

### Get Active Alarms
```bash
GET /api/supervision/alarms
```
Returns: All zones in ALARM state

### Get Active Tampers
```bash
GET /api/supervision/tampers
```
Returns: All zones in TAMPER state

### Get Active Troubles
```bash
GET /api/supervision/troubles
```
Returns: All zones in TROUBLE state

### Detect Available Boards
```bash
POST /api/supervision/detect-boards
```
Scans I2C bus for available supervision boards

---

## Common Use Cases

### Unlock Door 1
```bash
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"duration":3000}'
```

### Check Door 1 Supervision
```bash
curl http://localhost:3001/api/supervision/zone/0/1
```

### Read REX Button (Door 1)
```bash
curl http://localhost:3001/api/gpio/input/0
```

### Get All System Status
```bash
# GPIO
curl http://localhost:3001/api/gpio/status

# Supervision
curl http://localhost:3001/api/supervision/status
```

### Turn On Elevator (Relay 3)
```bash
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":3,"duration":5000}'
```

---

## I/O Mapping

### Relays (0-7)
```
0 = Door 1 Strike
1 = Door 2 Strike
2 = Door 3 Strike
3 = Door 4 Strike / Elevator
4-7 = Available for custom use
```

### Digital Inputs (0-7)
```
0 = Door 1 REX
1 = Door 2 REX
2 = Door 3 REX
3 = Door 4 REX
4-5 = Reserved
6 = Elevator Call Button
7 = Available
```

### Supervision Channels (ADC 1-8)
```
1 = Door 1 Supervised Zone
2 = Door 2 Supervised Zone
3 = Door 3 Supervised Zone
4 = Door 4 Supervised Zone
5-8 = Available for sensors
```

---

## Frontend API Functions

### Import
```typescript
import { 
  getGPIOStatus,
  setRelay,
  pulseRelay,
  unlockDoor,
  getDoorStatus,
  getSupervisionStatus 
} from '@/services/gpioApi';
```

### Usage Examples

#### Unlock Door
```typescript
await unlockDoor(1, 3000); // Door 1, 3 seconds
```

#### Get Door Status
```typescript
const { rex, supervision } = await getDoorStatus(1);
console.log('REX pressed:', rex.state === 1);
console.log('Zone state:', supervision.state);
```

#### Get System Status
```typescript
const gpioStatus = await getGPIOStatus();
const supervisionStatus = await getSupervisionStatus();
```

#### Control Specific Relay
```typescript
await setRelay(0, 1);  // Turn on relay 0
await setRelay(0, 0);  // Turn off relay 0
```

#### Pulse Relay
```typescript
await pulseRelay(0, 3000); // Pulse relay 0 for 3 seconds
```

#### Read Input
```typescript
const input = await readInput(0);
console.log('Input state:', input.state);
```

---

## Response Formats

### GPIO Status Response
```json
{
  "controller": "IOplus Home Automation",
  "healthy": true,
  "relays": [
    { "pin": 0, "state": 0, "label": "Door 1" },
    { "pin": 1, "state": 0, "label": "Door 2" },
    ...
  ],
  "inputs": [
    { "pin": 0, "state": 0, "label": "REX 1" },
    { "pin": 1, "state": 0, "label": "REX 2" },
    ...
  ]
}
```

### Supervision Status Response
```json
{
  "controller": "IOplus 1K/2K Supervision",
  "healthy": true,
  "boards": [
    {
      "boardId": 0,
      "address": 72,
      "zones": [
        {
          "zoneId": "board0-ch1",
          "board": 0,
          "channel": 1,
          "volts": 0.245,
          "raw": 50,
          "state": "NORMAL"
        },
        ...
      ]
    }
  ],
  "summary": {
    "totalZones": 8,
    "totalNormal": 6,
    "totalAlarms": 1,
    "totalTampers": 0,
    "totalTroubles": 1
  }
}
```

### Zone States
```
NORMAL  = 0.15V - 0.30V (green)
ALARM   = 0.30V - 0.75V (amber)
TAMPER  = 0.75V - 1.25V (red)
TROUBLE = 1.25V - 3.30V (purple)
```

---

## Testing Commands

### Quick Health Check
```bash
#!/bin/bash
echo "Testing GPIO..."
curl -s http://localhost:3001/api/gpio/health | jq

echo -e "\nTesting Supervision..."
curl -s http://localhost:3001/api/supervision/health | jq

echo -e "\nDone!"
```

### Full System Test
```bash
#!/bin/bash
echo "=== GPIO Status ==="
curl -s http://localhost:3001/api/gpio/status | jq

echo -e "\n=== Supervision Status ==="
curl -s http://localhost:3001/api/supervision/status | jq

echo -e "\n=== Test Door 1 Unlock ==="
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"duration":3000}' | jq

echo -e "\n=== Read Door 1 REX ==="
curl -s http://localhost:3001/api/gpio/input/0 | jq

echo -e "\n=== Read Door 1 Supervision ==="
curl -s http://localhost:3001/api/supervision/zone/0/1 | jq
```

---

## Browser Console Testing

```javascript
// Test GPIO
fetch('http://localhost:3001/api/gpio/status')
  .then(r => r.json())
  .then(console.log);

// Test Supervision
fetch('http://localhost:3001/api/supervision/status')
  .then(r => r.json())
  .then(console.log);

// Unlock Door 1
fetch('http://localhost:3001/api/gpio/pulse', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({pin: 0, duration: 3000})
})
  .then(r => r.json())
  .then(console.log);
```

---

**Keep this reference handy for quick API lookups!** 📋
