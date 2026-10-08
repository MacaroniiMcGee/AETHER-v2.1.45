import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  FileText, Download, Filter, Search, RefreshCw, Calendar, 
  TrendingUp, Activity, AlertTriangle, Shield, Zap, Clock,
  ChevronLeft, ChevronRight, X, BarChart3
} from 'lucide-react';

// Types
type LogEntry = {
  id?: string;
  time: string;
  timestamp?: number;
  message: string;
  type?: string;
  level?: 'info' | 'warning' | 'error' | 'success';
  source?: string;
  details?: any;
};

type SystemLogEntry = {
  time: string;
  timestamp?: number;
  type: 'success' | 'error' | 'warning' | 'info' | 'io' | 'door';
  message: string;
  details?: any;
};

type LogStats = {
  total: number;
  today: number;
  errors: number;
  warnings: number;
  byType: Record<string, number>;
  byHour: Record<string, number>;
};

interface ReportsProps {
  apiUrl?: string; // Made optional
  auditLog: LogEntry[];
  emulationLog: LogEntry[];
  systemLog: SystemLogEntry[];
  onClearAudit?: () => void;
  onClearEmulation?: () => void;
  onClearSystem?: () => void;
}

// Dynamic API URL helper
const getApiUrl = (): string => {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  return `${window.location.protocol}//${window.location.hostname}:3001`;
};

const Reports: React.FC<ReportsProps> = ({
  apiUrl: propApiUrl, // Renamed to distinguish from computed value
  auditLog,
  emulationLog,
  systemLog,
  onClearAudit,
  onClearEmulation,
  onClearSystem
}) => {
  // Use provided apiUrl or compute dynamically
  const apiUrl = propApiUrl || getApiUrl();
  // State
  const [activeTab, setActiveTab] = useState<'audit' | 'emulation' | 'system' | 'analytics'>('audit');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [dateRange, setDateRange] = useState<'today' | 'week' | 'month' | 'all'>('today');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(50);
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverLogs, setServerLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);

  // Combine and process logs
  const processedLogs = useMemo(() => {
    let logs: LogEntry[] = [];
    
    switch (activeTab) {
      case 'audit':
        logs = auditLog.map((log, idx) => ({ 
          ...log, 
          id: `audit-${idx}`,
          type: 'audit',
          level: 'info' as const,
          timestamp: new Date(log.time).getTime()
        }));
        break;
      case 'emulation':
        logs = emulationLog.map((log, idx) => ({ 
          ...log, 
          id: `emulation-${idx}`,
          type: 'emulation',
          level: 'info' as const,
          timestamp: new Date(log.time).getTime()
        }));
        break;
      case 'system':
        logs = systemLog.map((log, idx) => ({ 
          ...log, 
          id: `system-${idx}`,
          level: log.type === 'error' ? 'error' : 
                 log.type === 'warning' ? 'warning' : 
                 log.type === 'success' ? 'success' : 'info',
          timestamp: new Date(log.time).getTime()
        }));
        break;
    }

    // Add server logs if available
    if (serverLogs.length > 0 && activeTab === 'audit') {
      logs = [...serverLogs, ...logs];
    }

    // Apply filters
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      logs = logs.filter(log => 
        log.message.toLowerCase().includes(search) ||
        log.type?.toLowerCase().includes(search) ||
        JSON.stringify(log.details).toLowerCase().includes(search)
      );
    }

    if (filterType !== 'all') {
      logs = logs.filter(log => log.type === filterType);
    }

    if (filterLevel !== 'all') {
      logs = logs.filter(log => log.level === filterLevel);
    }

    // Date range filter
    const now = Date.now();
    const dayMs = 86400000;
    logs = logs.filter(log => {
      const logTime = log.timestamp || new Date(log.time).getTime();
      switch (dateRange) {
        case 'today':
          return now - logTime < dayMs;
        case 'week':
          return now - logTime < dayMs * 7;
        case 'month':
          return now - logTime < dayMs * 30;
        default:
          return true;
      }
    });

    // Sort by newest first
    logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return logs;
  }, [activeTab, auditLog, emulationLog, systemLog, serverLogs, searchTerm, filterType, filterLevel, dateRange]);

  // Pagination
  const totalPages = Math.ceil(processedLogs.length / itemsPerPage);
  const paginatedLogs = processedLogs.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Calculate stats
  useEffect(() => {
    const calculateStats = () => {
      const now = Date.now();
      const dayMs = 86400000;
      const todayLogs = processedLogs.filter(log => 
        now - (log.timestamp || new Date(log.time).getTime()) < dayMs
      );

      const byType: Record<string, number> = {};
      const byHour: Record<string, number> = {};
      let errors = 0;
      let warnings = 0;

      processedLogs.forEach(log => {
        // Count by type
        const type = log.type || 'unknown';
        byType[type] = (byType[type] || 0) + 1;

        // Count by hour (last 24 hours)
        const hour = new Date(log.time).getHours();
        byHour[hour] = (byHour[hour] || 0) + 1;

        // Count errors and warnings
        if (log.level === 'error') errors++;
        if (log.level === 'warning') warnings++;
      });

      setStats({
        total: processedLogs.length,
        today: todayLogs.length,
        errors,
        warnings,
        byType,
        byHour
      });
    };

    calculateStats();
  }, [processedLogs]);

  // Fetch logs from server
  const fetchServerLogs = useCallback(async () => {
    if (!apiUrl) return;
    
    setLoading(true);
    try {
      const response = await fetch(`${apiUrl}/api/logs?type=${activeTab}&limit=1000`);
      if (response.ok) {
        const data = await response.json();
        setServerLogs(data.logs || []);
      }
    } catch (error) {
      console.error('Failed to fetch server logs:', error);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, activeTab]);

  // Load logs on tab change
  useEffect(() => {
    if (activeTab !== 'analytics') {
      fetchServerLogs();
    }
  }, [activeTab, fetchServerLogs]);

  // Export logs
  const exportLogs = (format: 'json' | 'csv') => {
    const filename = `${activeTab}_logs_${new Date().toISOString().split('T')[0]}.${format}`;
    let content: string;

    if (format === 'json') {
      content = JSON.stringify(processedLogs, null, 2);
    } else {
      // CSV format
      const headers = ['Time', 'Type', 'Level', 'Message', 'Details'];
      const rows = processedLogs.map(log => [
        log.time,
        log.type || '',
        log.level || '',
        log.message,
        JSON.stringify(log.details || {})
      ]);
      
      content = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');
    }

    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Clear logs
  const clearLogs = () => {
    switch (activeTab) {
      case 'audit':
        onClearAudit?.();
        break;
      case 'emulation':
        onClearEmulation?.();
        break;
      case 'system':
        onClearSystem?.();
        break;
    }
    setServerLogs([]);
  };

  // Get icon for log level
  const getLevelIcon = (level?: string) => {
    switch (level) {
      case 'error':
        return <AlertTriangle className="w-4 h-4 text-red-400" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-yellow-400" />;
      case 'success':
        return <Shield className="w-4 h-4 text-green-400" />;
      default:
        return <Activity className="w-4 h-4 text-blue-400" />;
    }
  };

  // Get color for log level
  const getLevelColor = (level?: string) => {
    switch (level) {
      case 'error':
        return 'text-red-400';
      case 'warning':
        return 'text-yellow-400';
      case 'success':
        return 'text-green-400';
      default:
        return 'text-slate-300';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl p-6 border border-slate-700">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <FileText className="w-8 h-8 text-cyan-400" />
            <div>
              <h2 className="text-2xl font-bold">System Reports</h2>
              <p className="text-slate-400">Monitor access control events and system activity</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg flex items-center gap-2"
            >
              <Filter size={18} />
              Filters
            </button>
            <button
              onClick={fetchServerLogs}
              disabled={loading}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg flex items-center gap-2"
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('audit')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'audit' 
                ? 'bg-cyan-600 text-white' 
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            Audit Log
          </button>
          <button
            onClick={() => setActiveTab('system')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'system' 
                ? 'bg-cyan-600 text-white' 
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            System Log
          </button>
          <button
            onClick={() => setActiveTab('emulation')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'emulation' 
                ? 'bg-cyan-600 text-white' 
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            Emulation Log
          </button>
          <button
            onClick={() => setActiveTab('analytics')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'analytics' 
                ? 'bg-cyan-600 text-white' 
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            <BarChart3 size={18} className="inline mr-2" />
            Analytics
          </button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && activeTab !== 'analytics' && (
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="text-sm text-slate-400 mb-1 block">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search logs..."
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-10 pr-4 py-2"
                />
              </div>
            </div>
            
            <div>
              <label className="text-sm text-slate-400 mb-1 block">Type</label>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2"
              >
                <option value="all">All Types</option>
                <option value="access">Access</option>
                <option value="door">Door</option>
                <option value="system">System</option>
                <option value="io">I/O</option>
                <option value="wiegand">Wiegand</option>
                <option value="osdp">OSDP</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-slate-400 mb-1 block">Level</label>
              <select
                value={filterLevel}
                onChange={(e) => setFilterLevel(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2"
              >
                <option value="all">All Levels</option>
                <option value="info">Info</option>
                <option value="success">Success</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-slate-400 mb-1 block">Date Range</label>
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as any)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2"
              >
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
                <option value="all">All Time</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Stats Summary */}
      {activeTab !== 'analytics' && stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Total Logs</p>
                <p className="text-2xl font-bold">{stats.total.toLocaleString()}</p>
              </div>
              <Activity className="w-8 h-8 text-cyan-400" />
            </div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Today</p>
                <p className="text-2xl font-bold">{stats.today.toLocaleString()}</p>
              </div>
              <Calendar className="w-8 h-8 text-blue-400" />
            </div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Errors</p>
                <p className="text-2xl font-bold text-red-400">{stats.errors}</p>
              </div>
              <AlertTriangle className="w-8 h-8 text-red-400" />
            </div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Warnings</p>
                <p className="text-2xl font-bold text-yellow-400">{stats.warnings}</p>
              </div>
              <AlertTriangle className="w-8 h-8 text-yellow-400" />
            </div>
          </div>
        </div>
      )}

      {/* Analytics View */}
      {activeTab === 'analytics' && (
        <div className="space-y-6">
          {/* Activity Chart */}
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h3 className="text-xl font-bold mb-4">Activity Over Time</h3>
            <div className="h-64 flex items-end gap-1">
              {Object.entries(stats?.byHour || {}).map(([hour, count]) => {
                const maxCount = Math.max(...Object.values(stats?.byHour || {1: 1}));
                const height = (count / maxCount) * 100;
                
                return (
                  <div
                    key={hour}
                    className="flex-1 bg-cyan-600 hover:bg-cyan-500 transition-colors relative group"
                    style={{ height: `${height}%` }}
                  >
                    <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-slate-700 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity">
                      {count}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-xs text-slate-400">
              <span>00:00</span>
              <span>06:00</span>
              <span>12:00</span>
              <span>18:00</span>
              <span>23:00</span>
            </div>
          </div>

          {/* Event Types */}
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h3 className="text-xl font-bold mb-4">Event Types</h3>
            <div className="space-y-3">
              {Object.entries(stats?.byType || {}).map(([type, count]) => {
                const total = Object.values(stats?.byType || {}).reduce((a, b) => a + b, 0);
                const percentage = (count / total) * 100;
                
                return (
                  <div key={type}>
                    <div className="flex justify-between mb-1">
                      <span className="capitalize">{type}</span>
                      <span>{count} ({percentage.toFixed(1)}%)</span>
                    </div>
                    <div className="bg-slate-700 rounded-full h-3 overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-cyan-600 to-blue-600 h-full"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Logs Table */}
      {activeTab !== 'analytics' && (
        <>
          <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
            <div className="p-4 border-b border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                {activeTab === 'audit' && 'Audit Log Entries'}
                {activeTab === 'system' && 'System Log Entries'}
                {activeTab === 'emulation' && 'Emulation Log Entries'}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => exportLogs('json')}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm flex items-center gap-1"
                >
                  <Download size={16} />
                  JSON
                </button>
                <button
                  onClick={() => exportLogs('csv')}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm flex items-center gap-1"
                >
                  <Download size={16} />
                  CSV
                </button>
                <button
                  onClick={clearLogs}
                  className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded text-sm flex items-center gap-1"
                >
                  <X size={16} />
                  Clear
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-700/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-slate-300">Time</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-slate-300">Level</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-slate-300">Type</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-slate-300">Message</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-slate-300">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {paginatedLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-700/50 transition-colors">
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {log.time}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {getLevelIcon(log.level)}
                          <span className={`text-sm capitalize ${getLevelColor(log.level)}`}>
                            {log.level || 'info'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm capitalize">
                        {log.type || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="max-w-md truncate" title={log.message}>
                          {log.message}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {log.details && (
                          <details className="cursor-pointer">
                            <summary className="text-cyan-400 hover:text-cyan-300">
                              View Details
                            </summary>
                            <pre className="mt-2 p-2 bg-slate-900 rounded text-xs overflow-auto max-w-xs">
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {paginatedLogs.length === 0 && (
                <div className="text-center py-12 text-slate-400">
                  <Activity className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No logs found matching your filters</p>
                </div>
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="p-4 border-t border-slate-700 flex items-center justify-between">
                <div className="text-sm text-slate-400">
                  Showing {((currentPage - 1) * itemsPerPage) + 1} - {Math.min(currentPage * itemsPerPage, processedLogs.length)} of {processedLogs.length}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="p-2 rounded hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span className="px-3">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="p-2 rounded hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default Reports;
