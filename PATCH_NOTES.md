# 🔧 Patch Notes - Version 5.0

## Fixes Applied

### Issue 1: GPIO Routes Controller Reference ✅
**Problem:** `gpio-routes.js` was referencing wrong controller name
```javascript
// BEFORE (incorrect)
const sequentRelay = require('../controllers/sequentRelayController');

// AFTER (correct)
const ioplusController = require('../controllers/ioplusController');
```
**Impact:** Backend would crash on startup with "Cannot find module" error  
**Status:** FIXED

### Issue 2: Pin Registry Configuration ✅
**Problem:** wiegand-config.json had old pin reservations showing wrong pins
```
BEFORE:
Hardware Reserved (I2C/SPI): 2, 3, 7, 8, 9, 10, 11, 25
Wiegand Reserved: (empty)
Available for I/O: 4, 5, 6, 17, 18, 19, 20, 21, 22, 23, 24, 27

AFTER:
Hardware Reserved (I2C): 2, 3
Wiegand Reserved: 17, 27, 22, 23, 24, 25, 5, 6
OSDP Reserved: 12, 13, 16, 26, 19, 20, 21, 4
Available for I/O: (none - all pins assigned)
```
**Impact:** Pin registry console output was confusing and incorrect  
**Status:** FIXED

## Updated Files

1. **backend/routes/gpio-routes.js**
   - Fixed controller require statement
   - Changed all `sequentRelay` references to `ioplusController`

2. **backend/config/wiegand-config.json**
   - Updated to version 5.0-sequent
   - Added proper Wiegand reader pin reservations (4 readers)
   - Added OSDP reader pin reservations (4 readers)
   - Updated hardware reserved pins to only include I2C (2, 3)
   - Removed old SPI/RS485 HAT pins
   - Added comprehensive notes about Sequent IOplus setup

## Expected Console Output (After Fix)

```
[PinRegistry] Initialized:
  Hardware Reserved (I2C): 2, 3
  Wiegand Reserved: 5, 6, 17, 22, 23, 24, 25, 27
  Available for I/O: 
```

Note: No available I/O pins because all pins are assigned to specific functions:
- I2C (2,3): Sequent IOplus communication
- Wiegand RX (17,27,22,23,24,25,5,6): 4 readers
- OSDP Serial (12,13,16,26,19,20,21,4): 4 readers

## Testing After Update

1. **Verify backend starts:**
```bash
cd backend
sudo npm run dev
```

Should see:
```
[PinRegistry] Initialized:
  Hardware Reserved (I2C): 2, 3
  Wiegand Reserved: 5, 6, 17, 22, 23, 24, 25, 27
  Available for I/O: 
[GPIO] IOplus controller initialized
[Supervision] Supervision controller ready
[Server] API listening on port 3001
```

2. **Test GPIO API:**
```bash
curl http://localhost:3001/api/gpio/status
```

Should return JSON with relay and input status.

3. **Test Supervision API:**
```bash
curl http://localhost:3001/api/supervision/status
```

Should return JSON with zone monitoring data.

## Version History

- **v5.0** - Sequent IOplus integration with fixes
  - Fixed gpio-routes controller reference
  - Updated wiegand-config.json for proper pin reservations
  - Added OSDP pin tracking
  - Cleaned up hardware reserved pins

- **v4.1** - Previous version (had issues)
  - Had incorrect controller references
  - Had old pin configuration

## Files Affected

```
backend/routes/gpio-routes.js (FIXED)
backend/config/wiegand-config.json (UPDATED)
```

## No Action Required

These fixes are already included in the updated archives:
- integrated-project.zip
- integrated-project.tar.gz

Just extract and use!

---

**All issues resolved!** 🎉
