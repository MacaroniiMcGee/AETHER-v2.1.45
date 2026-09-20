// backend/automation/AutomationStorage.js
// Persists automation rules to disk

const fs = require('fs').promises;
const path = require('path');

class AutomationStorage {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '../data/automation-rules.json');
    this.autoSave = true;
    this.saveDebounceMs = 1000;
    this.saveTimeout = null;
  }

  // Load rules from file
  async loadRules() {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });

      // Try to read file
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      
      console.log(`[Storage] Loaded ${parsed.rules?.length || 0} rules from ${this.filePath}`);
      return parsed.rules || [];
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[Storage] No rules file found, starting with empty rules');
        return [];
      }
      console.error('[Storage] Error loading rules:', err.message);
      return [];
    }
  }

  // Save rules to file
  async saveRules(rules) {
    try {
      const data = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        rules: rules
      };

      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      
      await fs.writeFile(
        this.filePath,
        JSON.stringify(data, null, 2),
        'utf8'
      );
      
      console.log(`[Storage] Saved ${rules.length} rules to ${this.filePath}`);
      return true;
    } catch (err) {
      console.error('[Storage] Error saving rules:', err.message);
      return false;
    }
  }

  // Debounced save (useful for frequent updates)
  debouncedSave(rules) {
    if (!this.autoSave) return;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.saveRules(rules);
    }, this.saveDebounceMs);
  }

  // Export rules to JSON string
  exportRules(rules) {
    return JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      rules: rules
    }, null, 2);
  }

  // Import rules from JSON string
  importRules(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      return data.rules || [];
    } catch (err) {
      throw new Error(`Invalid JSON: ${err.message}`);
    }
  }

  // Create backup
  async createBackup() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = this.filePath.replace('.json', `-backup-${timestamp}.json`);
      
      const data = await fs.readFile(this.filePath, 'utf8');
      await fs.writeFile(backupPath, data, 'utf8');
      
      console.log(`[Storage] Backup created: ${backupPath}`);
      return backupPath;
    } catch (err) {
      console.error('[Storage] Error creating backup:', err.message);
      return null;
    }
  }
}

module.exports = AutomationStorage;
