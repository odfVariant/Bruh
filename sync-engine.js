const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SyncEngine {
  constructor(options = {}) {
    this.rootDir = options.rootDir || __dirname;
    
    // Choose data directory: prefer ./data inside rootDir so state persists in workspace
    let chosenDataDir = path.join(this.rootDir, 'data');
    if (options.dataDir) {
      chosenDataDir = options.dataDir;
    } else if (process.env.BRC_DATA_DIR) {
      chosenDataDir = process.env.BRC_DATA_DIR;
    } else {
      try {
        if (!fs.existsSync(chosenDataDir)) {
          fs.mkdirSync(chosenDataDir, { recursive: true });
        }
        fs.accessSync(chosenDataDir, fs.constants.W_OK);
      } catch (_) {
        chosenDataDir = '/data';
      }
    }

    this.dataDir = chosenDataDir;
    this.dataFile = options.dataFile || process.env.BRC_DATA_FILE || path.join(this.dataDir, 'brc-live-state.json');

    this.state = {};
    this.customDocsRegistry = [];
    this.version = 1;
    this.updatedAt = new Date().toISOString();
    this.clients = new Set();

    // Default password 'brickroad', overridable via env var BRC_MASTER_PASSWORD
    this.defaultMasterPassword = process.env.BRC_MASTER_PASSWORD || 'brickroad';
    this.masterPasswordHash = this.hashPassword(this.defaultMasterPassword);

    this.init();
  }

  destroy() {
    for (const client of this.clients) {
      try { client.res.end(); } catch (_) {}
    }
    this.clients.clear();
  }

  hashPassword(pwd) {
    return crypto.createHash('sha256').update(String(pwd || '').trim()).digest('hex');
  }

  init() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      this.load();
    } catch (err) {
      console.warn('[SyncEngine] Warning initializing data directory:', err.message);
    }
  }

  load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.state = parsed.state || parsed.customEditedHTML || parsed || {};
          if (Array.isArray(parsed.customDocsRegistry)) {
            this.customDocsRegistry = parsed.customDocsRegistry;
          }
          this.version = parsed.version || 1;
          this.updatedAt = parsed.updatedAt || new Date().toISOString();
          if (parsed.masterPasswordHash && !process.env.BRC_MASTER_PASSWORD) {
            this.masterPasswordHash = parsed.masterPasswordHash;
          }
          console.log(`[SyncEngine] Loaded ${Object.keys(this.state).length} state keys from ${this.dataFile} (v${this.version})`);
        }
      }
    } catch (err) {
      console.error('[SyncEngine] Error loading state from disk:', err.message);
    }
  }

  save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const payload = {
        version: this.version,
        updatedAt: this.updatedAt,
        masterPasswordHash: this.masterPasswordHash,
        customDocsRegistry: this.customDocsRegistry,
        state: this.state
      };
      // Atomic write: write to temp file then rename to avoid corruption
      const tmpFile = `${this.dataFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.dataFile);
    } catch (err) {
      console.error('[SyncEngine] Error saving state to disk:', err.message);
    }
  }

  verifyMasterPassword(pwd) {
    if (!pwd) return false;
    return this.hashPassword(pwd) === this.masterPasswordHash;
  }

  setMasterPassword(currentPwd, newPwd) {
    if (!this.verifyMasterPassword(currentPwd)) {
      return { success: false, error: 'Current Master password is incorrect.' };
    }
    if (!newPwd || String(newPwd).trim().length < 4) {
      return { success: false, error: 'New password must be at least 4 characters long.' };
    }
    this.masterPasswordHash = this.hashPassword(newPwd);
    this.save();
    return { success: true, message: 'Master password updated successfully.' };
  }

  getStateSummary() {
    return {
      version: this.version,
      updatedAt: this.updatedAt,
      connectedClients: this.clients.size,
      dataFile: this.dataFile,
      customDocsRegistry: this.customDocsRegistry,
      state: this.state
    };
  }

  applyUpdate(body) {
    if (!body || typeof body !== 'object') {
      return { success: false, error: 'Invalid update payload' };
    }

    const updates = Array.isArray(body.updates) ? body.updates : [body];
    const appliedKeys = [];
    const broadcastUpdates = [];
    const STORES = ['melrose', 'mesa', 'tempe'];

    if (Array.isArray(body.customDocsRegistry)) {
      this.customDocsRegistry = body.customDocsRegistry;
    }

    for (const item of updates) {
      if (!item) continue;
      const store = (item.store || '').toLowerCase().trim();
      const docId = (item.docId || '').trim();
      let key = (item.key || '').trim();
      if (!key && docId && store) {
        key = `${docId}__${store}`;
      } else if (!key && docId) {
        key = docId;
      }
      const value = item.value !== undefined ? item.value : '';

      if (!key) continue;

      const isMaster = store === 'master' || key.includes('__master');

      if (isMaster) {
        // Enforce Master Password
        const pwd = item.masterPassword || body.masterPassword || item.password || body.password;
        if (!this.verifyMasterPassword(pwd)) {
          return {
            success: false,
            requiresMasterAuth: true,
            error: 'Unauthorized: Valid Master password required to edit Master templates.'
          };
        }

        const masterKey = key.includes('__master') ? key : `${docId || key}__master`;
        this.state[masterKey] = value;
        appliedKeys.push(masterKey);
        broadcastUpdates.push({ key: masterKey, value, store: 'master' });

        // Seed initial SOP to stores that do NOT yet have a customized store copy (never overwrite existing store sheets!)
        const baseDoc = docId || masterKey.replace(/__master.*$/, '');
        const suffix = masterKey.includes('__simplified') ? '__simplified' : '';
        for (const st of STORES) {
          const storeKey = `${baseDoc}__${st}${suffix}`;
          if (this.state[storeKey] && !item.forceOverwriteStores) continue;
          let storeVal = value;
          if (typeof value === 'string' && value.includes('data-store-badge="true"')) {
            storeVal = value.replace(/(data-store-badge="true"[^>]*>)([^<]*)(<\/)/gi, `$1STORE: ${st.toUpperCase()}$3`);
          }
          this.state[storeKey] = storeVal;
          appliedKeys.push(storeKey);
          broadcastUpdates.push({ key: storeKey, value: storeVal, store: st, propagatedFrom: 'master' });
        }
      } else {
        // Scoped to specific store (melrose, mesa, or tempe)
        this.state[key] = value;
        appliedKeys.push(key);
        broadcastUpdates.push({ key, value, store: store || 'store' });
      }
    }

    if (appliedKeys.length > 0 || Array.isArray(body.customDocsRegistry)) {
      this.version += 1;
      this.updatedAt = new Date().toISOString();
      this.save();
      this.broadcast('state-update', {
        type: 'state-update',
        version: this.version,
        updatedAt: this.updatedAt,
        customDocsRegistry: this.customDocsRegistry,
        updates: broadcastUpdates
      });
      return {
        success: true,
        version: this.version,
        updatedAt: this.updatedAt,
        appliedKeys
      };
    }

    return { success: false, error: 'No valid state keys updated' };
  }

  updateStoreState(payload) {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid payload' };
    }
    const store = (payload.store || '').toLowerCase().trim();
    const isMaster = store === 'master';
    const pwd = payload.password || payload.masterPassword;
    if (isMaster && !this.verifyMasterPassword(pwd)) {
      return { success: false, requiresMasterAuth: true, error: 'Unauthorized: Valid Master password required.' };
    }
    if (Array.isArray(payload.customDocsRegistry)) {
      this.customDocsRegistry = payload.customDocsRegistry;
    }
    if (payload.customEditedHTML && typeof payload.customEditedHTML === 'object') {
      const entries = Object.entries(payload.customEditedHTML);
      if (entries.length === 0) {
        if (Array.isArray(payload.customDocsRegistry)) this.save();
        return {
          success: true,
          version: this.version,
          updatedAt: this.updatedAt,
          appliedKeys: []
        };
      }
      // Process store-specific keys FIRST so existing store customizations are registered before any __master fallback keys
      const sortedEntries = entries.slice().sort(([kA], [kB]) => {
        const aMaster = kA.includes('__master') ? 1 : 0;
        const bMaster = kB.includes('__master') ? 1 : 0;
        return aMaster - bMaster;
      });
      const updates = [];
      for (const [key, val] of sortedEntries) {
        if (!isMaster && key.includes('__master')) continue;
        updates.push({ key, value: val, store: key.includes('__master') ? 'master' : store, masterPassword: pwd });
      }
      if (updates.length === 0) {
        if (Array.isArray(payload.customDocsRegistry)) this.save();
        return {
          success: true,
          version: this.version,
          updatedAt: this.updatedAt,
          appliedKeys: []
        };
      }
      return this.applyUpdate({ updates, customDocsRegistry: payload.customDocsRegistry, masterPassword: pwd });
    }
    return this.applyUpdate(payload);
  }

  addClient(res) {
    this.clients.add(res);

    // Initial handshake event
    res.write(`event: init\ndata: ${JSON.stringify({
      type: 'init',
      version: this.version,
      updatedAt: this.updatedAt,
      state: this.state
    })}\n\n`);

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  close() {
    for (const client of this.clients) {
      try {
        client.end();
      } catch (_) {}
    }
    this.clients.clear();
  }
}

module.exports = SyncEngine;
