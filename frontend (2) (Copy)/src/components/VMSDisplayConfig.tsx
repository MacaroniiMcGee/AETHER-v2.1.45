import React, { useState, useEffect } from 'react';

interface DisplaySection {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  category: 'dashboard' | 'reports' | 'controls';
}

const VMSDisplayConfig: React.FC = () => {
  const [sections, setSections] = useState<DisplaySection[]>([
    // Dashboard Elements
    { id: 'doorStatus', name: 'Door Status Cards', description: 'Live status of all doors', enabled: true, category: 'dashboard' },
    { id: 'readerStatus', name: 'Reader Status', description: 'Reader assignment and connectivity', enabled: true, category: 'dashboard' },
    { id: 'liveActivity', name: 'Live Activity Feed', description: 'Real-time event stream', enabled: true, category: 'dashboard' },
    { id: 'inputOutput', name: 'I/O Status', description: 'Input/Output states', enabled: true, category: 'dashboard' },
    { id: 'elevatorControl', name: 'Elevator Control', description: 'Elevator floor buttons', enabled: false, category: 'dashboard' },
    { id: 'automationRules', name: 'Automation Rules', description: 'Active automation rules', enabled: false, category: 'dashboard' },
    
    // Report Elements (from EmulatorReportsPage)
    { id: 'reportOverview', name: 'Test Statistics Overview', description: 'Summary stats cards', enabled: true, category: 'reports' },
    { id: 'reportActivity', name: 'Reports Activity Feed', description: 'Detailed event log', enabled: true, category: 'reports' },
    { id: 'reportDoorStatus', name: 'Per-Door Statistics', description: 'Door-by-door breakdown', enabled: true, category: 'reports' },
    { id: 'reportAlerts', name: 'Test Notifications', description: 'Alerts and warnings', enabled: true, category: 'reports' },
    { id: 'reportCharts', name: 'Activity Charts', description: 'Hourly activity graphs', enabled: false, category: 'reports' },
    { id: 'reportInterface', name: 'Interface Status', description: 'System interface health', enabled: true, category: 'reports' },
    
    // Control Elements
    { id: 'quickActions', name: 'Quick Actions', description: 'Manual control buttons', enabled: false, category: 'controls' },
    { id: 'credentialSender', name: 'Credential Sender', description: 'Manual credential testing', enabled: false, category: 'controls' },
  ]);

  const [layoutMode, setLayoutMode] = useState<'compact' | 'standard' | 'detailed'>('standard');
  const [refreshInterval, setRefreshInterval] = useState<number>(5);
  const [showTimestamps, setShowTimestamps] = useState<boolean>(true);
  const [highlightChanges, setHighlightChanges] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  // Load saved configuration on mount
  useEffect(() => {
    loadConfiguration();
  }, []);

  const loadConfiguration = async () => {
    try {
      // Try loading from backend
      const response = await fetch('http://localhost:3001/api/vms/display-config');
      if (response.ok) {
        const config = await response.json();
        applySavedConfig(config);
      } else {
        // Fall back to localStorage
        const savedConfig = localStorage.getItem('vmsDisplayConfig');
        if (savedConfig) {
          applySavedConfig(JSON.parse(savedConfig));
        }
      }
    } catch (error) {
      console.error('Error loading VMS config:', error);
      // Try localStorage as fallback
      const savedConfig = localStorage.getItem('vmsDisplayConfig');
      if (savedConfig) {
        applySavedConfig(JSON.parse(savedConfig));
      }
    }
  };

  const applySavedConfig = (config: any) => {
    if (config.sections) {
      setSections(prevSections => 
        prevSections.map(section => ({
          ...section,
          enabled: config.sections[section.id] ?? section.enabled
        }))
      );
    }
    if (config.layoutMode) setLayoutMode(config.layoutMode);
    if (config.refreshInterval) setRefreshInterval(config.refreshInterval);
    if (config.showTimestamps !== undefined) setShowTimestamps(config.showTimestamps);
    if (config.highlightChanges !== undefined) setHighlightChanges(config.highlightChanges);
  };

  const toggleSection = (id: string) => {
    setSections(sections.map(s => 
      s.id === id ? { ...s, enabled: !s.enabled } : s
    ));
  };

  const toggleAllInCategory = (category: string, enabled: boolean) => {
    setSections(sections.map(s => 
      s.category === category ? { ...s, enabled } : s
    ));
  };

  const saveConfiguration = async () => {
    setIsSaving(true);
    
    const config = {
      sections: sections.reduce((acc, s) => ({ ...acc, [s.id]: s.enabled }), {}),
      layoutMode,
      refreshInterval,
      showTimestamps,
      highlightChanges,
      timestamp: new Date().toISOString()
    };

    try {
      // Save to backend
      const response = await fetch('http://localhost:3001/api/vms/display-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });

      if (response.ok) {
        console.log('VMS config saved to backend');
      }
    } catch (error) {
      console.error('Error saving to backend:', error);
    }

    // Always save to localStorage as fallback
    localStorage.setItem('vmsDisplayConfig', JSON.stringify(config));
    
    setIsSaving(false);
    setLastSaved(new Date().toLocaleTimeString());
    
    // Show success message
    setTimeout(() => setLastSaved(null), 3000);
  };

  const resetToDefaults = () => {
    if (confirm('Reset VMS display to default settings?')) {
      loadConfiguration(); // Reload defaults
    }
  };

  const previewInNewWindow = () => {
    const config = {
      sections: sections.reduce((acc, s) => ({ ...acc, [s.id]: s.enabled }), {}),
      layoutMode,
      refreshInterval,
      showTimestamps,
      highlightChanges
    };
    
    // Store temporarily for preview
    sessionStorage.setItem('vmsPreviewConfig', JSON.stringify(config));
    
    // Open dashboard in new window
    const previewWindow = window.open(
      window.location.origin + '/?vms-preview=true',
      'vmsPreview',
      'width=1920,height=1080'
    );
    
    if (previewWindow) {
      previewWindow.focus();
    }
  };

  const getSectionsByCategory = (category: string) => {
    return sections.filter(s => s.category === category);
  };

  const getCategoryName = (category: string) => {
    switch (category) {
      case 'dashboard': return 'Dashboard Elements';
      case 'reports': return 'Reports & Analytics';
      case 'controls': return 'Control Panels';
      default: return category;
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'dashboard': return '📊';
      case 'reports': return '📈';
      case 'controls': return '🎛️';
      default: return '•';
    }
  };

  const enabledCount = sections.filter(s => s.enabled).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white mb-2">VMS Display Configuration</h2>
            <p className="text-slate-400">Configure what appears on your Video Management System video wall</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-blue-400">{enabledCount}</div>
            <div className="text-sm text-slate-400">Elements Enabled</div>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-4">
          <div className="text-sm text-slate-400">RTSP Stream</div>
          <div className="text-lg font-bold text-blue-400 mt-1">rtsp://192.168.1.151:8554/live</div>
        </div>
        <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-4">
          <div className="text-sm text-slate-400">ONVIF Service</div>
          <div className="text-lg font-bold text-green-400 mt-1">http://192.168.1.151:8080/onvif/device_service</div>
        </div>
        <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-4">
          <div className="text-sm text-slate-400">Refresh Rate</div>
          <div className="text-lg font-bold text-purple-400 mt-1">{refreshInterval} seconds</div>
        </div>
      </div>

      {/* Display Options */}
      <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-6">
        <h3 className="text-lg font-bold text-white mb-4">Display Settings</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Layout Mode */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Layout Mode</label>
            <div className="space-y-2">
              {['compact', 'standard', 'detailed'].map(mode => (
                <label key={mode} className="flex items-center gap-3 p-3 border border-slate-600 rounded-lg hover:bg-slate-700/50 cursor-pointer">
                  <input
                    type="radio"
                    name="layoutMode"
                    value={mode}
                    checked={layoutMode === mode}
                    onChange={(e) => setLayoutMode(e.target.value as any)}
                    className="w-4 h-4 text-blue-600"
                  />
                  <div>
                    <div className="font-medium text-white capitalize">{mode}</div>
                    <div className="text-xs text-slate-400">
                      {mode === 'compact' && 'Maximum information density'}
                      {mode === 'standard' && 'Balanced view (recommended)'}
                      {mode === 'detailed' && 'Large text and spacing'}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Refresh Interval */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Auto-Refresh Interval: {refreshInterval}s
            </label>
            <input
              type="range"
              min="1"
              max="30"
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-slate-400 mt-1">
              <span>1s (Fast)</span>
              <span>30s (Slow)</span>
            </div>
          </div>
        </div>

        {/* Toggle Options */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
          <label className="flex items-center gap-3 p-4 border border-slate-600 rounded-lg hover:bg-slate-700/50 cursor-pointer">
            <input
              type="checkbox"
              checked={showTimestamps}
              onChange={(e) => setShowTimestamps(e.target.checked)}
              className="w-5 h-5 text-blue-600 rounded"
            />
            <div>
              <div className="font-medium text-white">Show Timestamps</div>
              <div className="text-sm text-slate-400">Display time on all events</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-4 border border-slate-600 rounded-lg hover:bg-slate-700/50 cursor-pointer">
            <input
              type="checkbox"
              checked={highlightChanges}
              onChange={(e) => setHighlightChanges(e.target.checked)}
              className="w-5 h-5 text-blue-600 rounded"
            />
            <div>
              <div className="font-medium text-white">Highlight Changes</div>
              <div className="text-sm text-slate-400">Animate new events</div>
            </div>
          </label>
        </div>
      </div>

      {/* Section Selection by Category */}
      {['dashboard', 'reports', 'controls'].map(category => {
        const categorySections = getSectionsByCategory(category);
        const categoryEnabled = categorySections.filter(s => s.enabled).length;
        
        return (
          <div key={category} className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{getCategoryIcon(category)}</span>
                <h3 className="text-lg font-bold text-white">
                  {getCategoryName(category)}
                </h3>
                <span className="text-sm text-slate-400">
                  ({categoryEnabled}/{categorySections.length} enabled)
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => toggleAllInCategory(category, true)}
                  className="px-3 py-1 text-sm bg-green-600/20 text-green-400 rounded hover:bg-green-600/30 transition-colors border border-green-600/30"
                >
                  Enable All
                </button>
                <button
                  onClick={() => toggleAllInCategory(category, false)}
                  className="px-3 py-1 text-sm bg-red-600/20 text-red-400 rounded hover:bg-red-600/30 transition-colors border border-red-600/30"
                >
                  Disable All
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {categorySections.map(section => (
                <label
                  key={section.id}
                  className={`flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-all ${
                    section.enabled
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-slate-600 hover:border-slate-500 hover:bg-slate-700/30'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={section.enabled}
                    onChange={() => toggleSection(section.id)}
                    className="w-5 h-5 text-blue-600 rounded mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-white">{section.name}</div>
                    <div className="text-sm text-slate-400 mt-1">{section.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      {/* Action Buttons */}
      <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-6">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex gap-3">
            <button
              onClick={saveConfiguration}
              disabled={isSaving}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 transition-colors font-medium"
            >
              {isSaving ? 'Saving...' : 'Save Configuration'}
            </button>
            
            <button
              onClick={previewInNewWindow}
              className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
            >
              Preview in New Window
            </button>

            <button
              onClick={resetToDefaults}
              className="px-6 py-3 bg-slate-600 text-white rounded-lg hover:bg-slate-700 transition-colors font-medium"
            >
              Reset to Defaults
            </button>
          </div>

          {lastSaved && (
            <div className="flex items-center gap-2 text-green-400 font-medium">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Saved at {lastSaved}
            </div>
          )}
        </div>

        <div className="mt-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-blue-400 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div className="text-sm text-blue-300">
              <div className="font-medium mb-1">How to use this configuration:</div>
              <ol className="list-decimal ml-4 space-y-1">
                <li>Select which dashboard elements to display on your VMS</li>
                <li>Configure layout mode and refresh rate</li>
                <li>Click "Save Configuration" to apply changes</li>
                <li>The ONVIF stream will update automatically to show selected elements</li>
                <li>Use "Preview" to see how it looks before deploying to VMS</li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VMSDisplayConfig;
