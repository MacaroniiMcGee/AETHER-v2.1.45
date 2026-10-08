import React from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import ClusterManager from './cluster/ClusterManager'
import IOAccessEmulator from './components/IOAccessEmulator'
import StreamView from './components/StreamView'
import DeviceFirmwareTool from './components/DeviceFirmwareTool'
import AnalyticsTool from './components/analytics/AnalyticsTool'   // AETHER-ANALYTICS

export default function App() {
  return (
    <Router>
      <Routes>
        {/* Cluster mode — the new default */}
        <Route path="/" element={<ClusterManager />} />
        {/* Legacy standalone mode — kept for direct access */}
        <Route path="/standalone" element={<IOAccessEmulator />} />
        <Route path="/stream" element={<StreamView />} />
        {/* Device firmware on its own page: http://<pi>:<port>/firmware */}
        <Route path="/firmware" element={<div className="min-h-screen p-6" style={{ background: 'rgb(var(--hv-surface))' }}><div className="max-w-[1400px] mx-auto"><DeviceFirmwareTool backendUrl={`${window.location.protocol}//${window.location.hostname}:3001`} /></div></div>} />
        <Route path="/analytics" element={<div className="min-h-screen p-6" style={{ background: 'rgb(var(--hv-surface))' }}><div className="max-w-[1600px] mx-auto"><AnalyticsTool backendUrl={`${window.location.protocol}//${window.location.hostname}:3001`} /></div></div>} />
      </Routes>
    </Router>
  )
}
