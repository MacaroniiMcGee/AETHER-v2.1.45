import React from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import IOAccessEmulator from './components/IOAccessEmulator'
import StreamView from './components/StreamView'

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<IOAccessEmulator />} />
        <Route path="/stream" element={<StreamView />} />
      </Routes>
    </Router>
  )
}
