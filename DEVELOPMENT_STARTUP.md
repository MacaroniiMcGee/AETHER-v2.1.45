# 🚀 Development Startup Guide

## Quick Start Commands

### **Backend (Terminal 1)**
```bash
cd integrated-project/backend

# Install dependencies (first time only)
npm install

# Start development server with auto-reload
sudo npm run dev
```

**Why sudo?** GPIO access requires root permissions on Raspberry Pi.

**What it does:** 
- Uses `nodemon` for auto-reload on file changes
- Runs on port 3001 (default)
- Watches for changes in .js files

---

### **Frontend (Terminal 2)**
```bash
cd integrated-project/frontend

# Install dependencies (first time only)
npm install

# Start development server with network access
npm run dev -- --host
```

**What `--host` does:**
- Makes Vite accessible from network (not just localhost)
- Allows testing from other devices on your network
- Shows network URL in console (e.g., http://192.168.1.100:5173)

**Default ports:**
- Local: http://localhost:5173
- Network: http://[your-ip]:5173

---

## 📋 Complete Startup Checklist

### First Time Setup

**1. Extract Project**
```bash
# Extract archive
unzip integrated-project.zip
# or
tar -xzf integrated-project.tar.gz

cd integrated-project
```

**2. Configure Backend**
```bash
cd backend

# Copy environment configuration
cp .env.sequent .env

# Or merge into existing .env:
# - RELAY_CONTROLLER=ioplus
# - SEQUENT_I2C_ADDRESS=0x28
# - (see .env.sequent for all settings)
```

**3. Verify Hardware**
```bash
# Check Sequent card
sudo i2cdetect -y 1
# Should show: 28

# Test ioplus CLI
ioplus 0 board
# Should display board info
```

**4. Install Dependencies**
```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

---

## 🎯 Running Development Servers

### Option 1: Two Terminal Windows

**Terminal 1 - Backend:**
```bash
cd integrated-project/backend
sudo npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd integrated-project/frontend
npm run dev -- --host
```

---

### Option 2: Using tmux (Single Terminal)

```bash
# Start tmux session
tmux new -s aether

# Split window horizontally
Ctrl+B then "

# Top pane - Backend
cd integrated-project/backend
sudo npm run dev

# Switch to bottom pane
Ctrl+B then Down Arrow

# Bottom pane - Frontend
cd integrated-project/frontend
npm run dev -- --host

# Detach from tmux
Ctrl+B then D

# Reattach later
tmux attach -t aether
```

---

### Option 3: Using screen (Single Terminal)

```bash
# Start backend in background screen
cd integrated-project/backend
screen -S backend -dm sudo npm run dev

# Start frontend in background screen
cd ../frontend
screen -S frontend -dm npm run dev -- --host

# View backend logs
screen -r backend

# Detach: Ctrl+A then D

# View frontend logs
screen -r frontend

# Detach: Ctrl+A then D

# Kill sessions when done
screen -X -S backend quit
screen -X -S frontend quit
```

---

### Option 4: Using PM2 (Production-like)

```bash
# Install PM2 globally (if not installed)
sudo npm install -g pm2

# Start backend
cd integrated-project/backend
pm2 start server.js --name aether-backend

# Start frontend (requires additional setup)
cd ../frontend
pm2 start npm --name aether-frontend -- run dev -- --host

# View logs
pm2 logs aether-backend
pm2 logs aether-frontend

# Stop
pm2 stop aether-backend aether-frontend

# Restart
pm2 restart aether-backend aether-frontend
```

---

## 🔍 Verify Everything is Running

### Check Backend
```bash
# Test GPIO API
curl http://localhost:3001/api/gpio/status

# Test Supervision API
curl http://localhost:3001/api/supervision/status

# Expected: JSON responses (not 404)
```

### Check Frontend
```bash
# Should see output like:
#   ➜  Local:   http://localhost:5173/
#   ➜  Network: http://192.168.1.100:5173/
#   ➜  press h + enter to show help

# Open in browser:
# - http://localhost:5173 (local)
# - http://[your-ip]:5173 (from other devices)
```

### Run Automated Tests
```bash
cd integrated-project
./test-system.sh
```

---

## 📊 What to Expect

### Backend Console Output
```
[Startup] Server starting...
[GPIO] IOplus controller initialized
[Supervision] Supervision controller ready
[Server] API listening on port 3001
[Socket.IO] WebSocket server ready
```

### Frontend Console Output
```
VITE v5.4.20  ready in 823 ms

➜  Local:   http://localhost:5173/
➜  Network: http://192.168.1.100:5173/
➜  press h + enter to show help
```

### Browser Console (Expected)
- No red errors
- Optional info messages
- WebSocket connection established

---

## 🛠️ Development Workflow

### Making Backend Changes
1. Edit any `.js` file in `backend/`
2. Nodemon automatically restarts server
3. Test with curl or frontend

### Making Frontend Changes
1. Edit any `.tsx` or `.ts` file in `frontend/src/`
2. Vite hot-reloads immediately (no page refresh needed)
3. See changes instantly in browser

### Debugging
```bash
# Backend logs
# Already visible in Terminal 1 or:
pm2 logs aether-backend

# Frontend errors
# Check browser console (F12)

# Hardware test
sudo i2cdetect -y 1
ioplus 0 relrd 1  # Read relay 1
```

---

## 🔧 Common Development Issues

### Backend won't start
```bash
# Check if port 3001 is already in use
sudo lsof -i :3001
# Kill existing process if needed
sudo kill -9 [PID]

# Check for syntax errors
node -c backend/server.js

# Check logs
tail -f backend/logs/*.log
```

### Frontend won't start
```bash
# Check if port 5173 is already in use
lsof -i :5173

# Clear cache and rebuild
rm -rf node_modules package-lock.json
npm install

# Check for TypeScript errors
npm run build
```

### Can't access frontend from network
```bash
# Make sure you used --host flag
npm run dev -- --host

# Check firewall
sudo ufw allow 5173

# Get your IP address
hostname -I
```

### GPIO errors
```bash
# Backend needs sudo
sudo npm run dev  # NOT: npm run dev

# Check I2C is enabled
sudo raspi-config
# Interface Options → I2C → Enable

# Test hardware
sudo i2cdetect -y 1
ioplus 0 board
```

---

## 🎨 Recommended Development Setup

### VS Code (Optional)
```bash
# Install VS Code extensions:
# - ESLint
# - Prettier
# - TypeScript and JavaScript
# - Tailwind CSS IntelliSense

# Open project
code integrated-project

# Use VS Code's integrated terminal
# View → Terminal (or Ctrl+`)
```

### Browser DevTools
- Open with F12
- Use Console tab for JavaScript errors
- Use Network tab to inspect API calls
- Use Components tab (React DevTools) for component debugging

---

## 📋 Daily Development Checklist

**Starting work:**
- [ ] cd to project directory
- [ ] Verify hardware: `sudo i2cdetect -y 1`
- [ ] Start backend: `sudo npm run dev`
- [ ] Start frontend: `npm run dev -- --host`
- [ ] Open browser to http://localhost:5173
- [ ] Check console for errors

**During development:**
- [ ] Backend changes auto-reload (nodemon)
- [ ] Frontend changes hot-reload (Vite)
- [ ] Test changes immediately
- [ ] Monitor both terminal outputs
- [ ] Check browser console

**Ending work:**
- [ ] Ctrl+C in both terminals to stop servers
- [ ] Or detach from tmux/screen sessions
- [ ] Or use `pm2 stop all`

---

## 🎯 Next Steps After Startup

1. **Test Backend APIs**
   ```bash
   curl http://localhost:3001/api/gpio/status
   curl http://localhost:3001/api/supervision/status
   ```

2. **Update Frontend Components**
   - See `INTEGRATION_GUIDE.md` for component updates
   - Add GPIO functions to DoorSettings.tsx
   - Add system monitoring to IOAccessEmulator.tsx

3. **Test Integration**
   - Click door unlock in UI
   - Verify relays activate
   - Check supervision states display

4. **Monitor System**
   - Watch terminal outputs
   - Check browser console
   - Run `./test-system.sh` periodically

---

## 🚀 Production Deployment

When ready for production:

```bash
# Build frontend
cd frontend
npm run build

# Use PM2 for backend
cd ../backend
pm2 start server.js --name aether-backend
pm2 save
pm2 startup

# Serve frontend build
# Use nginx or serve from express
```

---

## 📞 Quick Reference

**Backend Dev:** `sudo npm run dev` (port 3001)  
**Frontend Dev:** `npm run dev -- --host` (port 5173)  
**Test APIs:** `curl http://localhost:3001/api/gpio/status`  
**Stop Servers:** `Ctrl+C` in both terminals  
**View Logs:** Check terminal output or `pm2 logs`

---

**Happy developing!** 🎯

Need help? Check:
- `INTEGRATION_GUIDE.md` for detailed instructions
- `API_REFERENCE.md` for endpoint documentation
- Browser console (F12) for frontend errors
- Terminal output for backend errors
