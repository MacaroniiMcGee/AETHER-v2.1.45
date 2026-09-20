# 🚀 IOAccessEmulator - Sequent IOplus Edition

**Fully Integrated Access Control Emulator with GPIO Support**

[![Status](https://img.shields.io/badge/status-ready-green)]()
[![Integration](https://img.shields.io/badge/integration-complete-blue)]()
[![Hardware](https://img.shields.io/badge/hardware-Sequent_IOplus-orange)]()

---

## 🎯 Overview

This is your **complete and ready-to-deploy** IOAccessEmulator with Sequent IOplus GPIO board integration. All backend and frontend files have been merged and updated with GPIO support.

### What You Get
- ✅ **24 I/O Points:** 8 relays, 8 supervised inputs, 8 digital inputs
- ✅ **4 Door Control:** Complete door management with strikes and supervision
- ✅ **4-State Monitoring:** NORMAL, ALARM, TAMPER, TROUBLE detection
- ✅ **Full API:** RESTful endpoints for all I/O operations
- ✅ **TypeScript Support:** Complete type definitions for frontend
- ✅ **Real-time Updates:** Polling-based state monitoring
- ✅ **Multi-Reader Support:** 4 Wiegand + 4 OSDP readers configured

---

## 📦 What's Included

### Backend (/backend)
```
✅ GPIO Controller - Relay and input control
✅ Supervision Controller - 4-state zone monitoring
✅ GPIO Routes - API endpoints for I/O
✅ Supervision Routes - API endpoints for monitoring
✅ Updated server.js - Routes registered
✅ Reference .env - Complete configuration
✅ All your existing backend code (Wiegand, OSDP, automation, etc.)
```

### Frontend (/frontend)
```
✅ GPIO Type Definitions - TypeScript types
✅ Supervision Type Definitions - Zone state types
✅ Complete API Client - All GPIO/Supervision functions
✅ All your existing frontend code (components, utilities, etc.)
```

### Documentation
```
📖 INTEGRATION_GUIDE.md - Complete deployment guide
📖 PROJECT_STRUCTURE.md - File organization overview
📖 API_REFERENCE.md - Quick API lookup
📖 README.md - This file
```

---

## ⚡ Quick Start

### 1. Prerequisites
```bash
☐ Raspberry Pi with Sequent IOplus card installed
☐ I2C enabled (sudo raspi-config → Interface Options → I2C)
☐ Sequent software installed (ioplus command available)
☐ Node.js and npm installed
☐ Project files on your system
```

### 2. Verify Hardware
```bash
# Check Sequent card detected
sudo i2cdetect -y 1
# Should show: 28

# Test Sequent CLI
ioplus 0 board
# Should display board info

# Test relay
ioplus 0 relwr 1 1  # On
ioplus 0 relwr 1 0  # Off
```

### 3. Deploy Backend
```bash
# Navigate to backend
cd backend

# Update configuration
cp .env.sequent .env
# OR merge settings into your existing .env

# Install dependencies
npm install

# Start server
sudo node server.js
# OR with PM2: pm2 restart aether-backend
```

### 4. Test Backend
```bash
# Test GPIO
curl http://localhost:3001/api/gpio/status

# Test Supervision
curl http://localhost:3001/api/supervision/status

# Test door unlock
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"duration":3000}'
```

### 5. Deploy Frontend
```bash
# Navigate to frontend
cd frontend

# Install dependencies
npm install

# Option A: Development
npm run dev

# Option B: Production build
npm run build
```

### 6. Update Components

See `INTEGRATION_GUIDE.md` for detailed component updates. Quick summary:

**DoorSettings.tsx** - Add supervision monitoring and unlock handlers
**IOAccessEmulator.tsx** - Add system status display
**ElevatorSection.tsx** - Add elevator controls

All updates are **additive** - no need to replace entire files!

---

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| **INTEGRATION_GUIDE.md** | 📖 Complete step-by-step deployment guide |
| **PROJECT_STRUCTURE.md** | 🗂️ File organization and what's included |
| **API_REFERENCE.md** | 🔌 Quick API endpoint reference |
| **README.md** | 📋 This overview document |

**Start here:** Read `INTEGRATION_GUIDE.md` for complete deployment instructions.

---

## 🔌 API Endpoints

### GPIO
```
GET    /api/gpio/status              - System status
GET    /api/gpio/health              - Health check
POST   /api/gpio/set                 - Set relay
POST   /api/gpio/pulse               - Pulse relay
GET    /api/gpio/get/:pin            - Get relay state
GET    /api/gpio/input/:pin          - Read input
POST   /api/gpio/emergency-shutdown  - Emergency off
```

### Supervision
```
GET    /api/supervision/status       - Full status
GET    /api/supervision/health       - Health check
GET    /api/supervision/zone/:b/:c   - Read zone
GET    /api/supervision/alarms       - Active alarms
GET    /api/supervision/tampers      - Active tampers
GET    /api/supervision/troubles     - Active troubles
POST   /api/supervision/detect-boards - Detect boards
```

**Full reference:** See `API_REFERENCE.md`

---

## 🎮 Usage Examples

### Backend Testing (curl)
```bash
# Unlock door 1 (3 second pulse on relay 0)
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"duration":3000}'

# Check door 1 supervision zone
curl http://localhost:3001/api/supervision/zone/0/1
```

### Frontend (TypeScript)
```typescript
import { unlockDoor, getDoorStatus } from '@/services/gpioApi';

// Unlock door
await unlockDoor(1, 3000);

// Get door status
const { rex, supervision } = await getDoorStatus(1);
console.log('REX:', rex.state);
console.log('Zone:', supervision.state);
```

---

## 🗺️ I/O Mapping

### Relays (0-7)
```
0 = Door 1 Strike
1 = Door 2 Strike
2 = Door 3 Strike
3 = Door 4 Strike / Elevator
4-7 = Available
```

### Digital Inputs (0-7)
```
0 = Door 1 REX
1 = Door 2 REX
2 = Door 3 REX
3 = Door 4 REX
6 = Elevator Call
```

### Supervision (ADC 1-8)
```
1 = Door 1 Zone
2 = Door 2 Zone
3 = Door 3 Zone
4 = Door 4 Zone
5-8 = Available
```

---

## ✅ Integration Checklist

### Backend
- [ ] Hardware verified (i2cdetect shows 28)
- [ ] Backend files deployed
- [ ] .env configured with Sequent settings
- [ ] Server started (pm2 or node)
- [ ] GPIO API responds (curl test)
- [ ] Supervision API responds (curl test)
- [ ] No errors in logs

### Frontend
- [ ] Services copied to src/services/
- [ ] API service configured (gpioApi.ts)
- [ ] DoorSettings updated
- [ ] IOAccessEmulator updated
- [ ] ElevatorSection updated
- [ ] Build successful (npm run build)
- [ ] No TypeScript errors
- [ ] No console errors

### Testing
- [ ] Door unlock works from UI
- [ ] Supervision states display
- [ ] REX buttons detected
- [ ] System status accurate
- [ ] All 4 doors functional

---

## 🆘 Troubleshooting

### Backend Issues

**API returns 404**
```bash
# Verify routes registered
grep "gpio-routes" backend/server.js
grep "app.use('/api/gpio" backend/server.js

# If missing, check server.js was updated correctly
```

**Sequent not detected**
```bash
sudo i2cdetect -y 1  # Should show 28
ioplus 0 board       # Should show board info
```

**Server won't start**
```bash
pm2 logs aether-backend --lines 50
node -c backend/server.js
npm install
```

### Frontend Issues

**TypeScript errors**
```bash
# Verify files exist
ls -la frontend/src/services/

# Rebuild
npm run build
```

**API calls fail**
```bash
# Test in browser console
fetch('http://localhost:3001/api/gpio/status')
  .then(r => r.json())
  .then(console.log);
```

**Full troubleshooting:** See `INTEGRATION_GUIDE.md` → Troubleshooting section

---

## 🔧 Configuration

Key environment variables in `.env`:

```bash
# Sequent IOplus
RELAY_CONTROLLER=ioplus
SEQUENT_I2C_ADDRESS=0x28

# Supervision thresholds
SUPERVISION_NORMAL_MIN=0.15
SUPERVISION_NORMAL_MAX=0.30
SUPERVISION_ALARM_MIN=0.30
SUPERVISION_ALARM_MAX=0.75
SUPERVISION_TAMPER_MIN=0.75
SUPERVISION_TAMPER_MAX=1.25
SUPERVISION_TROUBLE_MIN=1.25
SUPERVISION_TROUBLE_MAX=3.30
```

**Full configuration:** See `.env.sequent`

---

## 📊 System Architecture

```
┌─────────────────┐
│   Frontend UI   │  React + TypeScript + Vite
│  (React/Vite)   │  - Door controls
└────────┬────────┘  - System monitoring
         │           - Real-time updates
         │ REST API
         │
┌────────▼────────┐
│  Backend API    │  Node.js + Express
│  (Express.js)   │  - GPIO routes
└────────┬────────┘  - Supervision routes
         │           - Automation
         │
┌────────▼────────┐
│  IOplus Board   │  Sequent Microsystems
│  (I2C 0x28)     │  - 8 relays
└─────────────────┘  - 8 supervised inputs
                     - 8 digital inputs
```

---

## 🎯 Next Steps

1. ✅ **Read** `INTEGRATION_GUIDE.md`
2. ✅ **Verify** hardware with i2cdetect
3. ✅ **Deploy** backend and test APIs
4. ✅ **Deploy** frontend and update components
5. ✅ **Test** end-to-end integration
6. ✅ **Monitor** logs and optimize

---

## 📈 Performance

**Recommended polling intervals:**
- Door supervision: 1000ms (1 Hz)
- System status: 2000ms (0.5 Hz)
- Elevator call: 200ms (5 Hz)

**Optimization tips:**
- Use `Promise.all()` for parallel API calls
- Clean up intervals on component unmount
- Batch status updates when possible

---

## 🎉 Success!

You'll know everything is working when:
1. ✅ Backend APIs respond with JSON
2. ✅ Door unlock buttons trigger relays
3. ✅ Supervision states update in real-time
4. ✅ No errors in logs or console
5. ✅ All 4 doors can be controlled

**Deployment time:** 1-2 hours

---

## 📞 Support

**Check logs:**
```bash
pm2 logs aether-backend --lines 50
```

**Test endpoints:**
```bash
curl http://localhost:3001/api/gpio/health
curl http://localhost:3001/api/supervision/health
```

**Verify hardware:**
```bash
sudo i2cdetect -y 1
ioplus 0 board
```

---

## 📄 License

Same license as your existing IOAccessEmulator project.

---

**Ready to deploy?** Start with `INTEGRATION_GUIDE.md` for step-by-step instructions! 🚀

**Questions?** Check the troubleshooting sections in the documentation.

**Happy coding!** 🎯
