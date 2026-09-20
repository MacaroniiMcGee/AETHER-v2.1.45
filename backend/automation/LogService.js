// backend/automation/LogService.js
class LogService {
  constructor(size = 1000) {
    this.size = size;
    this.buf = [];
  }
  push(entry) {
    this.buf.push({ ts: Date.now(), ...entry });
    if (this.buf.length > this.size) this.buf.shift();
  }
  all() {
    return this.buf.slice(-this.size);
  }
}
module.exports = LogService;

