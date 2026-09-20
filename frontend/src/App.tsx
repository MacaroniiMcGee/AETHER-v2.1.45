import React from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import ClusterManager from './cluster/ClusterManager'
import IOAccessEmulator from './components/IOAccessEmulator'
import StreamView from './components/StreamView'

export default function App() {
  return (
    <Router>
      <Routes>
        {/* Cluster mode — the new default */}
        <Route path="/" element={<ClusterManager />} />
        {/* Legacy standalone mode — kept for direct access */}
        <Route path="/standalone" element={<IOAccessEmulator />} />
        <Route path="/stream" element={<StreamView />} />
      </Routes>
    </Router>
  )
}
