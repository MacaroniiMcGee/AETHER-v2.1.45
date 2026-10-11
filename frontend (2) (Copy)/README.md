# Frontend - GPIO Emulator UI

React + TypeScript frontend for GPIO emulation system control panel.

## Project Structure

```
frontend/
├── src/
│   ├── api/               # API client functions
│   ├── components/        # React components
│   ├── data/             # Static data and types
│   ├── hooks/            # Custom React hooks
│   ├── lib/              # Utility libraries
│   ├── utils/            # Helper functions
│   ├── Readers/          # Reader-specific components
│   ├── App.tsx           # Main app component
│   ├── main.tsx          # Entry point
│   └── index.css         # Global styles
├── index.html            # HTML template
├── vite.config.ts        # Vite configuration
├── tailwind.config.js    # Tailwind CSS config
└── package.json          # Dependencies
```

## Key Features

- **Wiegand Control**: Configure and test Wiegand readers
- **OSDP Management**: Control OSDP devices
- **NFC Operations**: Manage NFC reader operations
- **Card Emulation**: Emulate various card formats
- **Automation Rules**: Create and manage automation rules
- **Real-time Monitoring**: Live device status and events

## Tech Stack

- **React 18** with TypeScript
- **Vite** for build tooling
- **Tailwind CSS** for styling
- **Lucide React** for icons
- **Shadcn/UI** for components

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start development server:
   ```bash
   npm run dev
   ```

3. Build for production:
   ```bash
   npm run build
   ```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

## Environment

The frontend connects to the backend API running on the configured endpoint. Update API endpoints in `src/api/` as needed.
