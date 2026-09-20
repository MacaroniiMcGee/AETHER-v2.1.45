# Integrated IOAccessEmulator Project Structure

## 📁 Project Overview

This is your **fully integrated** IOAccessEmulator with Sequent IOplus GPIO support.

---

## 🗂️ Directory Structure

```
integrated-project/
├── backend/
│   ├── controllers/
│   │   ├── ioplusController.js      ← NEW: GPIO control
│   │   └── supervisionController.js ← NEW: 4-state supervision
│   ├── routes/
│   │   ├── gpio-routes.js           ← NEW: GPIO API routes
│   │   ├── supervision-routes.js    ← NEW: Supervision API routes
│   │   └── ... (all your existing routes)
│   ├── server.js                     ← UPDATED: GPIO routes added
│   ├── .env.sequent                  ← NEW: Reference configuration
│   └── ... (all your existing backend files)
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── DoorSettings.tsx
│   │   │   ├── ElevatorSection.tsx
│   │   │   ├── IOAccessEmulator.tsx
│   │   │   └── ... (all your existing components)
│   │   ├── services/                 ← NEW: API services
│   │   │   ├── gpio.types.ts         ← NEW: GPIO TypeScript types
│   │   │   ├── supervision.types.ts  ← NEW: Supervision types
│   │   │   └── api.additions.ts      ← NEW: GPIO/Supervision API
│   │   └── ... (all your existing frontend files)
│   └── ... (package.json, vite.config.ts, etc.)
│
├── INTEGRATION_GUIDE.md             ← START HERE
└── PROJECT_STRUCTURE.md             ← This file
```

---

## 🔧 What's Been Done

### ✅ Backend Integration
1. **New Controllers Added:**
   - `ioplusController.js` - Controls 8 relays and 8 digital inputs
   - `supervisionController.js` - Manages 4-state zone monitoring

2. **New Routes Added:**
   - `gpio-routes.js` - Exposes `/api/gpio/*` endpoints
   - `supervision-routes.js` - Exposes `/api/supervision/*` endpoints

3. **server.js Updated:**
   - Added GPIO route imports
   - Registered `/api/gpio` and `/api/supervision` endpoints

4. **Configuration Reference:**
   - `.env.sequent` - Complete environment configuration for Sequent IOplus

### ✅ Frontend Integration
1. **Type Definitions:**
   - `gpio.types.ts` - TypeScript types for GPIO operations
   - `supervision.types.ts` - TypeScript types for supervision monitoring

2. **API Service:**
   - `api.additions.ts` - Complete API client for GPIO and supervision
   - Functions for all endpoints (status, control, monitoring)
   - Helper functions for door control and state management

---

## 🚀 Quick Deployment

### Option 1: Use This Integrated Project Directly
```bash
# Copy this entire folder to your system
cp -r integrated-project /path/to/your/project

# Follow INTEGRATION_GUIDE.md for deployment
```

### Option 2: Merge into Existing Project
```bash
# Copy backend files
cp integrated-project/backend/controllers/*.js your-project/backend/controllers/
cp integrated-project/backend/routes/gpio-routes.js your-project/backend/routes/
cp integrated-project/backend/routes/supervision-routes.js your-project/backend/routes/

# Copy frontend services
mkdir -p your-project/frontend/src/services
cp integrated-project/frontend/src/services/*.ts your-project/frontend/src/services/

# Update server.js
# Add the 4 lines shown in INTEGRATION_GUIDE.md

# Update .env
# Merge settings from .env.sequent
```

---

## 📖 Next Steps

1. **Read:** `INTEGRATION_GUIDE.md` (comprehensive deployment instructions)
2. **Deploy:** Follow the step-by-step guide
3. **Test:** Verify all endpoints work
4. **Update:** Modify frontend components as needed

---

## 🎯 Key Features

### Hardware I/O
- ✅ 8 Relay Outputs (door strikes, elevator, etc.)
- ✅ 8 Supervised Analog Inputs (4-state monitoring)
- ✅ 8 Digital Opto Inputs (REX buttons, sensors)

### API Endpoints
- ✅ `/api/gpio/*` - Complete relay and input control
- ✅ `/api/supervision/*` - 4-state zone monitoring

### Frontend Integration
- ✅ TypeScript types for type-safe development
- ✅ Complete API client with all functions
- ✅ Helper functions for common operations

---

## 🔍 File Descriptions

### Backend Controllers

**ioplusController.js**
- Interfaces with Sequent IOplus board
- Controls 8 relays via `ioplus` CLI
- Reads 8 digital inputs
- Provides health monitoring
- Endpoints: status, set, pulse, get, input

**supervisionController.js**
- Manages supervised analog inputs
- 4-state monitoring: NORMAL, ALARM, TAMPER, TROUBLE
- Voltage-based state detection
- Multiple board support (up to 8 boards)
- Endpoints: status, zone, alarms, tampers, troubles

### Backend Routes

**gpio-routes.js**
- Routes GPIO requests to ioplusController
- Validates input parameters
- Error handling and logging

**supervision-routes.js**
- Routes supervision requests to supervisionController
- Validates board and channel numbers
- Error handling and logging

### Frontend Services

**gpio.types.ts**
- TypeScript interfaces for GPIO operations
- Relay state types
- Input state types
- Response types for all GPIO endpoints

**supervision.types.ts**
- TypeScript interfaces for supervision
- Zone state types (4-state)
- Board configuration types
- Summary and statistics types

**api.additions.ts**
- Complete API client functions
- Fetch wrappers with error handling
- Helper functions for common operations
- Door control utilities

---

## 💡 Usage Examples

### Backend API Testing
```bash
# Get GPIO status
curl http://localhost:3001/api/gpio/status

# Unlock door 1 (pulse relay 0 for 3 seconds)
curl -X POST http://localhost:3001/api/gpio/pulse \
  -H "Content-Type: application/json" \
  -d '{"pin":0,"duration":3000}'

# Get supervision status
curl http://localhost:3001/api/supervision/status
```

### Frontend Component Usage
```typescript
import { unlockDoor, getDoorStatus } from '@/services/gpioApi';

// Unlock door
await unlockDoor(1, 3000);

// Get door status
const { rex, supervision } = await getDoorStatus(1);
console.log('REX pressed:', rex.state === 1);
console.log('Zone state:', supervision.state);
```

---

## 🆘 Need Help?

1. Check `INTEGRATION_GUIDE.md` for detailed instructions
2. Review the troubleshooting section
3. Check backend logs: `pm2 logs aether-backend`
4. Test APIs with curl commands
5. Verify hardware with `sudo i2cdetect -y 1`

---

## ✨ Ready to Deploy

All files are integrated and ready to use. Follow the `INTEGRATION_GUIDE.md` for step-by-step deployment instructions.

**Total files integrated:** 11
- Backend: 5 files (2 controllers, 2 routes, 1 config)
- Frontend: 3 files (2 types, 1 API service)
- Documentation: 3 files (updated server.js)

**Deployment time:** 1-2 hours

---

**Happy coding!** 🚀
