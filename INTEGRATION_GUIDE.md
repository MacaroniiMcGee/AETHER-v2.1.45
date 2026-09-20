# 🚀 Sequent IOplus Integration Guide
## Complete IOAccessEmulator GPIO Update

---

## 📦 **What's Been Integrated:**

### **Backend Updates:**
✅ New GPIO controller (`controllers/ioplusController.js`)
✅ New Supervision controller (`controllers/supervisionController.js`)
✅ GPIO routes (`routes/gpio-routes.js`)
✅ Supervision routes (`routes/supervision-routes.js`)
✅ Updated `server.js` with GPIO route registration
✅ Reference `.env.sequent` file with Sequent IOplus configuration

### **Frontend Updates:**
✅ GPIO TypeScript types (`frontend/src/services/gpio.types.ts`)
✅ Supervision TypeScript types (`frontend/src/services/supervision.types.ts`)
✅ API service functions (`frontend/src/services/api.additions.ts`)

---

## 🎯 **Hardware Capabilities:**

### **I/O Configuration:**
- **8 Relay Outputs** (Sequent IOplus via I2C 0x28)
- **8 Supervised Analog Inputs** (4-state monitoring: NORMAL/ALARM/TAMPER/TROUBLE)
- **8 Digital Opto Inputs**

### **GPIO Pin Assignment:**
- **I2C:** GPIO 2, 3 (Sequent IOplus)
- **Wiegand Readers (4):** GPIO 17,27,22,23,24,25,5,6
- **OSDP Readers (4):** GPIO 12,13,16,26,19,20,21,4

### **Door I/O Mapping:**
```
Door 1: Relay 0 | REX Input 0 | Supervision ADC 1
Door 2: Relay 1 | REX Input 1 | Supervision ADC 2
Door 3: Relay 2 | REX Input 2 | Supervision ADC 3
Door 4: Relay 3 | REX Input 3 | Supervision ADC 4
```

---

## ⚡ **Quick Start Deployment:**

### **Prerequisites:**
```bash
# Ensure you have:
☐ Raspberry Pi with Sequent IOplus card installed
☐ i2c enabled (sudo raspi-config → Interface Options → I2C)
☐ Sequent software installed (ioplus command)
☐ Node.js and npm installed
☐ Project files copied to your system
```

### **Step 1: Verify Hardware**
```bash
# Check if Sequent card is detected
sudo i2cdetect -y 1
# Should show: 28 (hex address)

# Test Sequent CLI
ioplus 0 board
# Should show board info

# Test relay
ioplus 0 relwr 1 1  # Turn on relay 1
ioplus 0 relwr 1 0  # Turn off relay 1
```

### **Step 2: Deploy Backend**

```bash
# Navigate to your project
cd /path/to/your/project

# Copy the integrated backend files
cp -r integrated-project/backend/* ./backend/

# Update environment configuration
cp integrated-project/backend/.env.sequent ./backend/.env
# OR manually merge settings into your existing .env

# Install any missing dependencies
cd backend
npm install

# Verify server.js syntax
node -c server.js

# Start or restart the backend
# Option A: Using PM2
pm2 restart aether-backend
pm2 logs aether-backend --lines 20

# Option B: Direct node
sudo node server.js
```

### **Step 3: Test Backend APIs**

```bash
# Test GPIO endpoint
curl http://localhost:3001/api/gpio/status

# Expected response:
# {
#   "controller": "IOplus Home Automation",
#   "healthy": true,
#   "relays": [...],
#   "inputs": [...]
# }

# Test Supervision endpoint
curl http://localhost:3001/api/supervision/status

# Expected response:
# {
#   "controller": "IOplus 1K/2K Supervision",
#   "healthy": true,
#   "boards": [...],
#   "summary": {...}
# }

# Test relay control
curl -X POST http://localhost:3001/api/gpio/set \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"state":1}'

# Test relay pulse (door unlock)
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"duration":3000}'
```

### **Step 4: Deploy Frontend**

```bash
# Navigate to frontend
cd ../frontend

# Copy integrated frontend files
cp -r ../integrated-project/frontend/src/services ./src/

# Option A: Use api.additions.ts as separate file
mv src/services/api.additions.ts src/services/gpioApi.ts

# Option B: Merge into existing api.ts
# (Manual merge - copy functions from api.additions.ts into your api.ts)

# Install dependencies
npm install

# Build frontend
npm run build

# Or run dev server
npm run dev
```

### **Step 5: Update Frontend Components**

Follow the component-specific updates in the next section.

---

## 🔧 **Frontend Component Updates:**

### **1. Create/Update API Service**

**Option A: Standalone GPIO API**
```typescript
// src/services/gpioApi.ts (rename api.additions.ts)
// Use as-is, already complete with all functions
```

**Option B: Merge into Existing API**
```typescript
// In your existing src/services/api.ts
// Copy all functions from api.additions.ts
```

### **2. Update DoorSettings.tsx**

Add to your existing `DoorSettings.tsx`:

```typescript
// Add imports
import { pulseRelay, readSupervisionZone } from '@/services/gpioApi';
import type { SupervisionZone } from '@/services/supervision.types';

// Add state
const [supervisionState, setSupervisionState] = useState<SupervisionZone | null>(null);

// Add supervision polling
useEffect(() => {
  const pollSupervision = async () => {
    try {
      const response = await readSupervisionZone(0, doorId); // doorId 1-4
      setSupervisionState(response.zone);
    } catch (error) {
      console.error('Supervision poll failed:', error);
    }
  };

  const interval = setInterval(pollSupervision, 1000);
  pollSupervision();
  return () => clearInterval(interval);
}, [doorId]);

// Update unlock handler
const handleUnlock = async () => {
  try {
    const relayPin = doorId - 1; // Door 1-4 → Relay 0-3
    await pulseRelay(relayPin, 3000);
    console.log(`Door ${doorId} unlocked`);
  } catch (error) {
    console.error('Unlock failed:', error);
  }
};

// Add supervision display
{supervisionState && (
  <div className={`px-3 py-2 rounded-lg ${
    supervisionState.state === 'NORMAL' ? 'bg-green-500/20' :
    supervisionState.state === 'ALARM' ? 'bg-amber-500/20' :
    supervisionState.state === 'TAMPER' ? 'bg-red-500/20' :
    'bg-purple-500/20'
  }`}>
    <div className="text-sm font-medium">
      Zone: {supervisionState.state}
    </div>
    <div className="text-xs opacity-80">
      {supervisionState.volts.toFixed(3)}V
    </div>
  </div>
)}
```

### **3. Update IOAccessEmulator.tsx**

Add system status monitoring:

```typescript
// Add imports
import { getGPIOStatus, getSupervisionStatus } from '@/services/gpioApi';
import type { GPIOStatus } from '@/services/gpio.types';
import type { SupervisionStatus } from '@/services/supervision.types';

// Add state
const [gpioStatus, setGpioStatus] = useState<GPIOStatus | null>(null);
const [supervisionStatus, setSupervisionStatus] = useState<SupervisionStatus | null>(null);

// Add polling
useEffect(() => {
  const pollSystemStatus = async () => {
    try {
      const [gpio, supervision] = await Promise.all([
        getGPIOStatus(),
        getSupervisionStatus()
      ]);
      setGpioStatus(gpio);
      setSupervisionStatus(supervision);
    } catch (error) {
      console.error('System status poll failed:', error);
    }
  };

  const interval = setInterval(pollSystemStatus, 2000);
  pollSystemStatus();
  return () => clearInterval(interval);
}, []);

// Add status display
<div className="grid grid-cols-3 gap-4">
  <div className="bg-slate-800 p-4 rounded-lg">
    <h3 className="text-sm font-medium mb-2">Relays</h3>
    <div className="text-2xl font-bold">
      {gpioStatus?.relays.filter(r => r.state === 1).length || 0}
      <span className="text-sm opacity-60">/{gpioStatus?.relays.length || 8}</span>
    </div>
    <div className="text-xs opacity-60">Active</div>
  </div>
  
  <div className="bg-slate-800 p-4 rounded-lg">
    <h3 className="text-sm font-medium mb-2">Supervision</h3>
    <div className="text-2xl font-bold text-amber-500">
      {supervisionStatus?.summary.totalAlarms || 0}
    </div>
    <div className="text-xs opacity-60">Alarms</div>
  </div>
  
  <div className="bg-slate-800 p-4 rounded-lg">
    <h3 className="text-sm font-medium mb-2">Security</h3>
    <div className="text-2xl font-bold text-red-500">
      {supervisionStatus?.summary.totalTampers || 0}
    </div>
    <div className="text-xs opacity-60">Tampers</div>
  </div>
</div>
```

### **4. Update ElevatorSection.tsx**

Add elevator controls:

```typescript
// Add imports
import { readInput, pulseRelay } from '@/services/gpioApi';

// Add state
const [callButtonPressed, setCallButtonPressed] = useState(false);

// Monitor call button (Input 6)
useEffect(() => {
  const pollCallButton = async () => {
    try {
      const response = await readInput(6);
      setCallButtonPressed(response.state === 1);
    } catch (error) {
      console.error('Call button poll failed:', error);
    }
  };

  const interval = setInterval(pollCallButton, 200);
  pollCallButton();
  return () => clearInterval(interval);
}, []);

// Elevator control (Relay 3)
const handleElevatorDoor = async () => {
  try {
    await pulseRelay(3, 5000);
    console.log('Elevator door activated');
  } catch (error) {
    console.error('Elevator control failed:', error);
  }
};

// Display call button
<div className={`flex items-center gap-2 px-3 py-2 rounded ${
  callButtonPressed ? 'bg-amber-500/30' : 'bg-gray-500/30'
}`}>
  <Bell className="w-4 h-4" />
  <span>Call Button: {callButtonPressed ? 'PRESSED' : 'Idle'}</span>
</div>
```

---

## 📊 **API Endpoints Reference:**

### **GPIO Endpoints:**
```
GET    /api/gpio/status              - Complete system status
GET    /api/gpio/health              - Health check
POST   /api/gpio/set                 - Set relay state
POST   /api/gpio/pulse               - Pulse relay
GET    /api/gpio/get/:pin            - Get relay state
GET    /api/gpio/input/:pin          - Read digital input
POST   /api/gpio/emergency-shutdown  - Turn off all relays
```

### **Supervision Endpoints:**
```
GET    /api/supervision/status       - Complete supervision status
GET    /api/supervision/health       - Health check
GET    /api/supervision/zone/:board/:channel - Read specific zone
GET    /api/supervision/alarms       - Get active alarms
GET    /api/supervision/tampers      - Get active tampers
GET    /api/supervision/troubles     - Get active troubles
POST   /api/supervision/detect-boards - Detect available boards
```

---

## ⚙️ **Environment Configuration:**

Key `.env` settings for Sequent IOplus:

```bash
# Sequent IOplus Configuration
RELAY_CONTROLLER=ioplus
SEQUENT_I2C_ADDRESS=0x28

# NFC Disabled (using Sequent instead)
NFC_ENABLED=false

# Wiegand Reader Pins
WIEGAND_READER_1_D0=17
WIEGAND_READER_1_D1=27
WIEGAND_READER_2_D0=22
WIEGAND_READER_2_D1=23
WIEGAND_READER_3_D0=24
WIEGAND_READER_3_D1=25
WIEGAND_READER_4_D0=5
WIEGAND_READER_4_D1=6

# OSDP Reader Pins
OSDP_READER_1_TX=12
OSDP_READER_1_RX=13
# ... (see .env.sequent for all)

# Supervision Thresholds (volts)
SUPERVISION_NORMAL_MIN=0.15
SUPERVISION_NORMAL_MAX=0.30
SUPERVISION_ALARM_MIN=0.30
SUPERVISION_ALARM_MAX=0.75
SUPERVISION_TAMPER_MIN=0.75
SUPERVISION_TAMPER_MAX=1.25
SUPERVISION_TROUBLE_MIN=1.25
SUPERVISION_TROUBLE_MAX=3.30
```

---

## ✅ **Verification Checklist:**

### **Backend:**
```bash
☐ pm2 status shows "online"
☐ curl /api/gpio/status returns JSON (not 404)
☐ curl /api/supervision/status returns JSON (not 404)
☐ No errors in pm2 logs
☐ Can control relays via API
☐ Can read inputs via API
```

### **Frontend:**
```bash
☐ npm run build succeeds
☐ No TypeScript errors
☐ Dashboard loads without errors
☐ Door unlock buttons work
☐ Supervision states display
☐ No console errors
☐ Real-time updates work
```

### **Hardware:**
```bash
☐ sudo i2cdetect -y 1 shows 28
☐ ioplus commands work
☐ Relays click when activated
☐ Inputs read correctly
```

---

## 🔍 **Testing Workflow:**

### **1. Test Backend Only:**
```bash
# Start backend
cd backend
sudo node server.js

# In another terminal, test APIs:
curl http://localhost:3001/api/gpio/status
curl http://localhost:3001/api/supervision/status

# Test door unlock
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"duration":3000}'
```

### **2. Test Frontend Only:**
```bash
cd frontend
npm run dev

# Open browser console and test:
fetch('http://localhost:3001/api/gpio/status')
  .then(r => r.json())
  .then(console.log);
```

### **3. Full System Test:**
```bash
# With both backend and frontend running:
☐ Click door unlock in UI → Should see relay activate
☐ Check supervision display → Should show zone states
☐ Monitor logs → Should see no errors
☐ Test all 4 doors → All should work
```

---

## 🆘 **Troubleshooting:**

### **Backend Issues:**

**Problem: API returns 404**
```bash
# Check routes are registered
grep "gpio-routes" backend/server.js
grep "app.use('/api/gpio" backend/server.js

# If missing, routes weren't added correctly
# Verify server.js has the GPIO route imports and app.use statements
```

**Problem: Sequent not detected**
```bash
# Check I2C
sudo i2cdetect -y 1
# Should show 28

# Check Sequent software
ioplus 0 board

# If fails, check hardware connection
```

**Problem: pm2 shows "errored"**
```bash
pm2 logs aether-backend --lines 50
node -c backend/server.js
cd backend && npm install
pm2 restart aether-backend
```

### **Frontend Issues:**

**Problem: TypeScript errors**
```bash
# Verify types are in correct location
ls -la frontend/src/services/

# Should show:
# - gpio.types.ts
# - supervision.types.ts
# - api.additions.ts (or gpioApi.ts)

# Rebuild
cd frontend && npm run build
```

**Problem: API calls fail**
```bash
# Check backend is running
pm2 status

# Check API URL in code
# Should be: http://localhost:3001

# Test in browser console:
fetch('http://localhost:3001/api/gpio/status')
  .then(r => r.json())
  .then(console.log);
```

---

## 📈 **Performance Tips:**

### **Polling Intervals:**
```typescript
// Recommended intervals:
Door Supervision:     1000ms (1 second)
System Status:        2000ms (2 seconds)
Elevator Call Button: 200ms  (5 Hz)
```

### **Optimization:**
```typescript
// Use Promise.all for parallel fetches
const [gpio, supervision] = await Promise.all([
  getGPIOStatus(),
  getSupervisionStatus()
]);

// Cleanup intervals on unmount
useEffect(() => {
  const interval = setInterval(poll, 1000);
  return () => clearInterval(interval);
}, []);
```

---

## 🎯 **Next Steps:**

1. ✅ **Deploy backend** - Get APIs working first
2. ✅ **Test with curl** - Verify all endpoints respond
3. ✅ **Add API service** - Create gpioApi.ts
4. ✅ **Update components** - DoorSettings → IOAccessEmulator → ElevatorSection
5. ✅ **Test integration** - Full end-to-end testing
6. ✅ **Monitor logs** - Check for errors, optimize polling

---

## 📞 **Support:**

### **Check Logs:**
```bash
# Backend
pm2 logs aether-backend --lines 100

# Test endpoints
curl http://localhost:3001/api/gpio/health
curl http://localhost:3001/api/supervision/health

# Hardware
sudo i2cdetect -y 1
ioplus 0 board
```

### **Common Issues:**
- **404 Errors:** Routes not registered in server.js
- **i2c Errors:** Hardware not detected, check connections
- **TypeScript Errors:** Types not in correct location
- **CORS Errors:** Backend not running on port 3001

---

## 🎉 **Success Criteria:**

You'll know it's working when:
1. ✅ Backend APIs respond with JSON
2. ✅ Door unlock buttons trigger relays
3. ✅ Supervision states display in real-time
4. ✅ No errors in logs or console
5. ✅ All 4 doors can be controlled
6. ✅ System status shows accurate data

**Estimated Integration Time: 1-2 hours**

---

**Good luck with your integration!** 🚀

If you encounter any issues, check the logs first and verify each step in the checklist.
