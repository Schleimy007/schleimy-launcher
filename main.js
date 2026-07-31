require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const { fetch } = require('undici');
const fs = require('fs');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const AdmZip = require('adm-zip');
const { exec } = require('child_process');
const DiscordRPC = require('discord-rpc');
const Hyperswarm = require('hyperswarm');
const crypto = require('crypto');
const b4a = require('b4a');
const net = require('net');
const { autoUpdater } = require('electron-updater');
const launcher = new Client();

// ===== API CONSTANTS =====
const MODRINTH_API = 'https://api.modrinth.com/v2';
const CF_API = 'https://api.curseforge.com/v1';
const CF_API_KEY = process.env.CF_API_KEY;
const CF_GAME_ID = 432; // Minecraft
const CF_HEADERS = {
    'Accept': 'application/json',
    'x-api-key': CF_API_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
};
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CF_CLASS = {
    mod: 6,
    modpack: 4471,
    resourcepack: 12,
    shader: 6552,
};
const CF_LOADER = {
    forge: 1,
    fabric: 4,
    neoforge: 6,
    quilt: 5,
};

// ===== GLOBAL ERROR PROTECTION (ANTI-CRASH) =====
process.on('uncaughtException', (err) => {
    console.error('[SCHLEIMY ANTI-CRASH] Uncaught Exception:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send('toast-notification', {
                type: 'error',
                message: `Hintergrund-Fehler abgefangen: ${err.message || 'Unbekannter Fehler'}`
            });
        } catch (_) {}
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[SCHLEIMY ANTI-CRASH] Unhandled Rejection:', reason);
});

// ===== IN-MEMORY API CACHE (5-MIN TTL) =====
const API_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
async function fetchCachedJSON(url, options = {}, ttl = CACHE_TTL_MS) {
    const cacheKey = url + JSON.stringify(options);
    const cached = API_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < ttl)) {
        return cached.data;
    }
    const res = await fetch(url, options);
    if (!res.ok) {
        throw new Error(`API error ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    API_CACHE.set(cacheKey, { timestamp: Date.now(), data });
    return data;
}

let mainWindow;
let logWindow = null;
let gameProcess = null;
let gameStartTime = null;

// ===== P2P HOSTING VARIABLES =====
let hostSwarm = null;
let clientSwarm = null;
let localProxyServer = null;
let pendingHostType = null;
let pendingHostProfileData = null;
let activeHostCode = null;
const PUBLIC_SERVERS_TOPIC = crypto.createHash('sha256').update('SchleimyLauncher-PublicServers-v1').digest();
// ===== PATHS (Feature 20: Portable Mode) =====
const isPortable = fs.existsSync(path.join(__dirname, '.portable'));
const baseDir = isPortable
    ? path.join(__dirname, 'data')
    : path.join(app.getPath('appData'), '.schleimy_launcher');
const instancesDir = path.join(baseDir, 'instances');
const profilesPath = path.join(baseDir, 'profiles.json');
const settingsPath = path.join(baseDir, 'settings.json');
const authEncPath = path.join(baseDir, 'auth.dat');
const authPlainPath = path.join(baseDir, 'auth.json');
const accountsPath = path.join(baseDir, 'accounts.json');
const serversPath = path.join(baseDir, 'servers.json');
const statsPath = path.join(baseDir, 'stats.json');
const javaDir = path.join(baseDir, 'java');

// ===== PERSISTENCE HELPERS =====
function ensureDirs() {
    [baseDir, instancesDir, javaDir].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}
function loadJSON(filePath, fallback) {
    try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
}
function saveJSON(filePath, data) { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); }
function loadProfiles() {
    const profiles = loadJSON(profilesPath, {});
    const cleaned = {};
    let dirty = false;
    for (const [name, data] of Object.entries(profiles)) {
        const profilePath = path.join(instancesDir, name);
        if (fs.existsSync(profilePath)) {
            cleaned[name] = data;
        } else {
            dirty = true;
        }
    }
    if (dirty) saveProfiles(cleaned);
    return cleaned;
}
function saveProfiles(profiles) { saveJSON(profilesPath, profiles); }
function loadSettings() {
    const defaults = { setupCompleted: false, ram: 4, javaPath: '', showSnapshots: false, theme: 'jade', accentColor: '#00AF5C', jvmPreset: 'default', discordRPC: true, parallelDownloads: 4, backgroundImage: '' };
    return { ...defaults, ...loadJSON(settingsPath, {}) };
}
function saveSettingsFile(settings) { const current = loadSettings(); saveJSON(settingsPath, { ...current, ...settings }); }
function loadAccounts() { return loadJSON(accountsPath, []); }
function saveAccounts(accounts) { saveJSON(accountsPath, accounts); }
function loadServers() { return loadJSON(serversPath, []); }
function saveServers(servers) { saveJSON(serversPath, servers); }
function loadStats() { return loadJSON(statsPath, {}); }
function saveStats(stats) { saveJSON(statsPath, stats); }
function recordPlaytimeForProfile(profileName, seconds) {
    if (!profileName || typeof seconds !== 'number' || seconds <= 0) return;
    const stats = loadStats();
    const current = stats[profileName] || { playSeconds: 0, sessions: 0, lastPlayed: null };
    current.playSeconds += seconds;
    current.sessions += 1;
    current.lastPlayed = new Date().toISOString();
    stats[profileName] = current;
    saveStats(stats);
}

// ===== AUTH =====
function saveAuthToken(token) {
    try {
        if (safeStorage.isEncryptionAvailable()) {
            fs.writeFileSync(authEncPath, safeStorage.encryptString(JSON.stringify(token)));
            if (fs.existsSync(authPlainPath)) fs.unlinkSync(authPlainPath);
            return;
        }
    } catch (_) {}
    saveJSON(authPlainPath, token);
}
function loadAuthToken() {
    try { if (fs.existsSync(authEncPath) && safeStorage.isEncryptionAvailable()) return JSON.parse(safeStorage.decryptString(fs.readFileSync(authEncPath))); } catch (_) {}
    try { if (fs.existsSync(authPlainPath)) return loadJSON(authPlainPath, null); } catch (_) {}
    return null;
}
function clearAuthToken() { [authEncPath, authPlainPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }); }

// ===== EVENT SENDER =====
function sendEvent(type, message, data) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher-event', { type, message, data: data || null });
    if (logWindow && !logWindow.isDestroyed()) logWindow.webContents.send('launcher-event', { type, message, data: data || null });
}

// ===== DISCORD RPC =====
DiscordRPC.register(DISCORD_CLIENT_ID);
let rpc = new DiscordRPC.Client({ transport: 'ipc' });
let rpcReady = false;

async function setupDiscordRPC() {
    const settings = loadSettings();
    if (!settings.discordRPC) {
        if (rpcReady) { rpc.clearActivity().catch(()=>{}); rpcReady = false; }
        return;
    }
    
    if (!rpcReady) {
        rpc.on('ready', () => {
            rpcReady = true;
            updateDiscordRPC('Im Hauptmenü', 'Durchstöbert Modpacks');
        });
        try { await rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(()=>{}); } catch(e) {}
    } else {
        updateDiscordRPC('Im Hauptmenü', 'Durchstöbert Modpacks');
    }
}

function updateDiscordRPC(details, state, startTimestamp = null) {
    if (!rpcReady) return;
    const settings = loadSettings();
    if (!settings.discordRPC) { rpc.clearActivity().catch(()=>{}); return; }
    
    rpc.setActivity({
        details: details,
        state: state,
        startTimestamp: startTimestamp,
        largeImageKey: 'icon_large',
        largeImageText: 'Schleimy Launcher',
        instance: false,
    }).catch(()=>{});
}

// ===== JVM PRESETS (Feature 6) =====
const JVM_PRESETS = {
    default: [],
    aikar: ['-XX:+UseG1GC','-XX:+ParallelRefProcEnabled','-XX:MaxGCPauseMillis=200','-XX:+UnlockExperimentalVMOptions','-XX:+DisableExplicitGC','-XX:+AlwaysPreTouch','-XX:G1NewSizePercent=30','-XX:G1MaxNewSizePercent=40','-XX:G1HeapRegionSize=8M','-XX:G1ReservePercent=20','-XX:G1HeapWastePercent=5','-XX:G1MixedGCCountTarget=4','-XX:InitiatingHeapOccupancyPercent=15','-XX:G1MixedGCLiveThresholdPercent=90','-XX:G1RSetUpdatingPauseTimePercent=5','-XX:SurvivorRatio=32','-XX:+PerfDisableSharedMem','-XX:MaxTenuringThreshold=1'],
    zgc: ['-XX:+UseZGC','-XX:+ZGenerational'],
    shenandoah: ['-XX:+UseShenandoahGC','-XX:ShenandoahGCHeuristics=compact']
};

// ===== JAR PARSING HELPERS (for dependency detection) =====
function simpleParseModsToml(content) {
    const modIds = [];
    const dependencies = {};
    let currentSection = 'top';
    let currentDepSection = null;
    let currentDep = null;
    for (const line of content.split('\n')) {
        let t = line.split('#')[0].trim();
        if (!t) continue;
        const sec = t.match(/^\[\[(.+)\]\]$/);
        if (sec) {
            const sn = sec[1];
            if (sn === 'mods') { currentSection = 'mods'; currentDepSection = null; currentDep = null; }
            else if (sn.startsWith('dependencies')) {
                currentSection = 'deps';
                currentDepSection = sn.includes('.') ? sn.slice(sn.indexOf('.') + 1).replace(/^"/,'').replace(/"$/,'') : 'global';
                if (!dependencies[currentDepSection]) dependencies[currentDepSection] = [];
                currentDep = null;
            } else { currentSection = 'other'; currentDepSection = null; currentDep = null; }
            continue;
        }
        const kv = t.match(/^(\w+)\s*=\s*(.+)$/);
        if (!kv) continue;
        const key = kv[1];
        const val = kv[2].replace(/^"/,'').replace(/"$/,'');
        if (currentSection === 'mods' && key === 'modId') modIds.push(val);
        if (currentSection === 'deps' && currentDepSection) {
            if (key === 'modId') {
                currentDep = { modId: val, mandatory: true, versionRange: '*' };
                dependencies[currentDepSection].push(currentDep);
            }
            else if (currentDep && key === 'mandatory') currentDep.mandatory = val === 'true';
            else if (currentDep && key === 'type') {
                if (val.toLowerCase() === 'optional' || val.toLowerCase() === 'incompatible') currentDep.mandatory = false;
            }
            else if (currentDep && key === 'versionRange') currentDep.versionRange = val;
        }
    }
    return { modIds, dependencies };
}

function parseJarForDependencies(jarPath) {
    try {
        const zip = new AdmZip(jarPath);
        const tomlEntry = zip.getEntry('META-INF/neoforge.mods.toml') || zip.getEntry('META-INF/mods.toml');
        if (tomlEntry) {
            const parsed = simpleParseModsToml(zip.readAsText(tomlEntry));
            return { type: 'forge', modIds: parsed.modIds, dependencies: parsed.dependencies };
        }
        const fabricEntry = zip.getEntry('fabric.mod.json');
        if (fabricEntry) {
            const jsonData = JSON.parse(zip.readAsText(fabricEntry));
            const mIds = jsonData.id ? [jsonData.id] : [];
            const deps = {};
            if (jsonData.depends) {
                for (const [depId, range] of Object.entries(jsonData.depends)) {
                    if (!deps[depId]) deps[depId] = [];
                    deps[depId].push({ modId: depId, mandatory: true, versionRange: String(range) });
                }
            }
            return { type: 'fabric', modIds: mIds, dependencies: deps };
        }
        const quiltEntry = zip.getEntry('quilt.mod.json');
        if (quiltEntry) {
            const jsonData = JSON.parse(zip.readAsText(quiltEntry));
            const ql = jsonData.quilt_loader || {};
            const mIds = ql.id ? [ql.id] : [];
            const deps = {};
            if (ql.depends) {
                for (const [depId, depEntry] of Object.entries(ql.depends)) {
                    if (!deps[depId]) deps[depId] = [];
                    const mandatory = typeof depEntry === 'object' ? depEntry.optional !== true : true;
                    const range = typeof depEntry === 'object' ? (depEntry.version || '*') : String(depEntry);
                    deps[depId].push({ modId: depId, mandatory, versionRange: range });
                }
            }
            return { type: 'quilt', modIds: mIds, dependencies: deps };
        }
    } catch (e) {
        console.warn('parseJarForDependencies failed:', jarPath, e.message);
    }
    return null;
}

async function resolveNestedDeps(deps, loader, mcVersion, resolvedIds, depth) {
    if (depth > 5) return [];
    if (!resolvedIds) resolvedIds = new Set();
    const downloads = [];
    for (const dep of deps || []) {
        if (dep.dependency_type !== 'required') continue;
        try {
            let vInfo;
            if (dep._cfId) {
                const key = `cf:${dep._cfId}`;
                if (resolvedIds.has(key)) continue;
                resolvedIds.add(key);
                vInfo = await getCurseForgeModVersion(dep._cfId, loader, mcVersion);
            } else if (dep.version_id) {
                if (resolvedIds.has(dep.version_id)) continue;
                resolvedIds.add(dep.version_id);
                const res = await fetch(`${MODRINTH_API}/version/${dep.version_id}`, {
                    headers: { 'User-Agent': 'SchleimyLauncher/6.0.0' }
                });
                if (!res.ok) continue;
                const vData = await res.json();
                vInfo = { url: vData.files[0]?.url, filename: vData.files[0]?.filename, dependencies: vData.dependencies || [], versionId: vData.id, versionNumber: vData.version_number, projectId: vData.project_id, source: 'modrinth' };
            } else if (dep.project_id) {
                if (resolvedIds.has(dep.project_id)) continue;
                resolvedIds.add(dep.project_id);
                vInfo = await getModrinthModVersion(dep.project_id, loader, mcVersion);
            }
            if (vInfo && vInfo.url) {
                downloads.push({ url: vInfo.url, filename: vInfo.filename, projectId: vInfo.projectId, source: vInfo.source, versionId: vInfo.versionId, versionNumber: vInfo.versionNumber });
                if (vInfo.dependencies && vInfo.dependencies.length > 0) {
                    const nested = await resolveNestedDeps(vInfo.dependencies, loader, mcVersion, resolvedIds, depth + 1);
                    downloads.push(...nested);
                }
            }
        } catch (e) {
            console.warn('resolveNestedDeps failed for', dep?.modId || dep?.project_id, e.message);
        }
    }
    return downloads;
}

async function installDownloads(downloads, profileName, errors, installed) {
    const seenFiles = new Set();
    for (const item of downloads) {
        if (!item || !item.filename || !item.url) continue;
        if (seenFiles.has(item.filename)) continue;
        seenFiles.add(item.filename);
        try {
            const res = await downloadModFile({ ...item, profileName });
            if (res.success) installed.push(item.filename);
            else errors.push(`Installieren von ${item.filename} fehlgeschlagen: ${res.error}`);
        } catch (e) {
            errors.push(`Installieren von ${item.filename} fehlgeschlagen: ${e.message}`);
        }
    }
}

function createLogWindow() {
    if (logWindow && !logWindow.isDestroyed()) {
        logWindow.show();
        return;
    }
    logWindow = new BrowserWindow({
        width: 1000, height: 600,
        backgroundColor: '#0d0d12',
        title: 'Minecraft Log',
        autoHideMenuBar: true,
        frame: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    logWindow.loadFile('log.html');
}

// ===== WINDOW =====
let tray = null;
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1380, height: 900, minWidth: 940, minHeight: 620,
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
        autoHideMenuBar: true, backgroundColor: '#111111', show: false,
        frame: false,
        icon: path.join(__dirname, 'build', 'logo.png')
    });
    mainWindow.loadFile('index.html');
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level >= 2) console.error(`[RENDERER CONSOLE]: ${message} (${sourceId}:${line})`);
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    
    // Feature 9: Tray
    if (!tray) {
        tray = new Tray(path.join(__dirname, 'build', 'logo.png'));
        const updateTrayMenu = () => {
            const profiles = loadProfiles();
            const profileItems = Object.keys(profiles).map(name => ({
                label: name,
                click: () => {
                    mainWindow.show();
                    sendEvent('tray-launch', 'Launch Profile', name);
                }
            }));
            const contextMenu = Menu.buildFromTemplate([
                { label: 'Zeige/Verstecke Launcher', click: () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show() },
                { type: 'separator' },
                ...profileItems,
                { type: 'separator' },
                { label: 'Beenden', click: () => { app.isQuitting = true; app.quit(); } }
            ]);
            tray.setContextMenu(contextMenu);
            tray.setToolTip('Schleimy Launcher');
        };
        updateTrayMenu();
        tray.on('click', () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show());
    }

    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });
}

ipcMain.handle('p2p-fetch-public', async () => {
    return new Promise((resolve) => {
        const servers = [];
        const tempSwarm = new Hyperswarm();
        tempSwarm.on('error', () => {}); // Prevent crash
        tempSwarm.on('connection', (conn, info) => {
            conn.on('data', data => {
                try {
                    const infoObj = JSON.parse(data.toString());
                    if (infoObj.type === 'server-info') {
                        const srv = { ...infoObj, code: crypto.createHash('sha256').update(conn.remotePublicKey).digest('hex').substring(0,6) };
                        servers.push(srv);
                        sendEvent('public-server-found', 'Server gefunden', srv);
                    }
                } catch(e) {}
            });
        });
        tempSwarm.join(PUBLIC_SERVERS_TOPIC, { server: false, client: true });
        setTimeout(() => { tempSwarm.destroy(); resolve(servers); }, 15000);
    });
});

ipcMain.handle('p2p-get-info', async (_e, { code }) => {
    return new Promise((resolve) => {
        const tempSwarm = new Hyperswarm();
        tempSwarm.on('error', () => {});
        const joinTopic = crypto.createHash('sha256').update(code).digest();
        let timer = setTimeout(() => { tempSwarm.destroy(); resolve(null); }, 8000);
        tempSwarm.on('connection', (conn) => {
            let buffer = '';
            conn.on('data', data => {
                buffer += data.toString();
                if (buffer.includes('\n')) {
                    try { const info = JSON.parse(buffer.split('\n')[0]); if (info.type === 'server-info') { clearTimeout(timer); tempSwarm.destroy(); resolve(info); } } catch(e) {}
                }
            });
        });
        tempSwarm.join(joinTopic, { server: false, client: true });
    });
});

ipcMain.handle('p2p-join', async (_e, { code }) => {
    if (clientSwarm) stopP2P();
    return new Promise((resolve) => {
        clientSwarm = new Hyperswarm();
        clientSwarm.on('error', () => {});
        const joinTopic = crypto.createHash('sha256').update(code).digest();
        let connected = false;
        let timeout = setTimeout(() => { if (!connected) { stopP2P(); resolve({ success: false, error: 'Host nicht gefunden.' }); } }, 10000);

        clientSwarm.on('connection', (conn) => {
            if (connected) { conn.destroy(); return; }
            connected = true;
            clearTimeout(timeout);
            localProxyServer = net.createServer(socket => {
                conn.write('JOIN\n');
                socket.pipe(conn).pipe(socket);
                socket.on('error', () => {});
            });
            localProxyServer.listen(25565, '127.0.0.1', () => resolve({ success: true, localPort: 25565 }));
            localProxyServer.on('error', (err) => { stopP2P(); resolve({ success: false, error: 'Port 25565 belegt.' }); });
        });
        clientSwarm.join(joinTopic, { server: false, client: true });
    });
});

app.whenReady().then(() => { 
    ensureDirs(); 
    createWindow(); 
    setupDiscordRPC(); 
    
    autoUpdater.on('update-available', () => {
        if (mainWindow) mainWindow.webContents.send('launcher-event', { type: 'update-start' });
    });
    autoUpdater.on('update-not-available', () => {
        sendEvent('info', 'Dein Launcher ist auf dem neuesten Stand.');
    });
    autoUpdater.on('download-progress', (progressObj) => {
        if (mainWindow) mainWindow.webContents.send('launcher-event', { type: 'update-progress', data: { percent: progressObj.percent } });
    });
    autoUpdater.on('update-downloaded', () => {
        if (mainWindow) mainWindow.webContents.send('launcher-event', { type: 'update-ready' });
        dialog.showMessageBox({
            type: 'info',
            title: 'Update bereit',
            message: 'Ein neues Update wurde heruntergeladen. Die Anwendung wird jetzt neu gestartet, um das Update zu installieren.',
            buttons: ['OK']
        }).then(() => {
            autoUpdater.quitAndInstall();
        });
    });
    autoUpdater.on('error', (err) => {
        console.error('Updater Error:', err);
        sendEvent('error', `Update-Fehler: ${err.message || 'Unbekannter Fehler'}`);
    });
    autoUpdater.checkForUpdates();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ===== WINDOW CONTROLS IPC =====
ipcMain.handle('window-minimize', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); return true; });
ipcMain.handle('window-maximize', (e) => { 
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return true; 
});
ipcMain.handle('window-close', (e, shift) => { 
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (shift) {
        app.isQuitting = true;
        app.quit();
    } else {
        win.hide();
    }
    return true; 
});

// ===== API IPC (Moved from Renderer) =====

// Helper: wraps a promise with a timeout so it rejects instead of hanging
function timeoutPromise(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
    ]);
}

async function searchCurseForge(query, facets, limit = 20, offset = 0) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const url = new URL(`${CF_API}/mods/search`);
        url.searchParams.append('gameId', CF_GAME_ID);
        url.searchParams.append('searchFilter', query);
        url.searchParams.append('pageSize', limit);
        url.searchParams.append('index', offset);
        url.searchParams.append('sortField', 2); // Popularity
        url.searchParams.append('sortOrder', 'desc');

        if (facets.type && CF_CLASS[facets.type]) url.searchParams.append('classId', CF_CLASS[facets.type]);
        if (facets.loader && CF_LOADER[facets.loader]) url.searchParams.append('modLoaderType', CF_LOADER[facets.loader]);
        if (facets.version) url.searchParams.append('gameVersion', facets.version);

        const res = await fetch(url, { headers: CF_HEADERS, signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
            console.error('CurseForge API Error:', res.status, res.statusText, await res.text());
            return { hits: [], total_hits: 0, error: `CurseForge API Error: ${res.status}` };
        }
        const data = await res.json();

        const hits = data.data.map(mod => ({
            slug: `cf:${mod.id}`, title: mod.name, description: mod.summary,
            author: mod.authors?.[0]?.name || 'Unbekannt', icon_url: mod.logo?.thumbnailUrl || '',
            downloads: mod.downloadCount, versions: mod.latestFilesIndexes?.map(f => f.gameVersion) || [],
            categories: mod.latestFilesIndexes?.map(f => {
                const lt = f.modLoader;
                if (lt === 1) return 'forge'; if (lt === 4) return 'fabric'; if (lt === 6) return 'neoforge'; if (lt === 5) return 'quilt';
                return '';
            }).filter(Boolean) || [],
            project_type: Object.entries(CF_CLASS).find(([, v]) => v === mod.classId)?.[0] || 'mod',
            _source: 'curseforge', _cfId: mod.id,
            date_modified: mod.dateModified,
        }));

        return { hits, total_hits: data.pagination?.totalCount || hits.length };
    } catch (e) {
        if (e.name === 'AbortError') {
            console.warn('CurseForge search timed out');
            return { hits: [], total_hits: 0, error: 'CurseForge-Suche: Zeitüberschreitung (8s)' };
        }
        console.error('CurseForge search error:', e);
        return { hits: [], total_hits: 0, error: e.message };
    }
}

async function searchModrinth(query, facets, limit = 20, offset = 0) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const facetArray = [];
        if (facets.type) facetArray.push([`project_type:${facets.type}`]);
        if (facets.loader) facetArray.push([`categories:${facets.loader}`]);
        if (facets.version) facetArray.push([`versions:${facets.version}`]);
        if (facets.category) {
            if (Array.isArray(facets.category)) {
                if (facets.category.length > 0) facetArray.push(facets.category.map(c => `categories:${c}`));
            } else {
                facetArray.push([`categories:${facets.category}`]);
            }
        }

        const url = new URL(`${MODRINTH_API}/search`);
        url.searchParams.append('query', query);
        url.searchParams.append('limit', limit);
        url.searchParams.append('offset', offset);
        if (facetArray.length > 0) url.searchParams.append('facets', JSON.stringify(facetArray));

        const res = await fetch(url, { 
            signal: controller.signal,
            headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' }
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error('Modrinth search failed');
        const data = await res.json();
        data.hits.forEach(h => { h._source = 'modrinth'; });
        return data;
    } catch (e) {
        if (e.name === 'AbortError') {
            console.warn('Modrinth search timed out');
            return { hits: [], total_hits: 0, error: 'Modrinth-Suche: Zeitüberschreitung (20s)' };
        }
        console.error('Modrinth search error:', e);
        return { hits: [], total_hits: 0, error: e.message };
    }
}

ipcMain.handle('api:searchAll', async (_e, { query, facets, limit, offset, source }) => {
    if (facets.loader === 'vanilla' && (!facets.type || facets.type === 'mod' || facets.type === 'modpack')) {
        return { hits: [], total_hits: 0 };
    }

    if (source === 'curseforge') return searchCurseForge(query, facets, limit, offset);
    if (source === 'modrinth') return searchModrinth(query, facets, limit, offset);

    // Sequential: run CurseForge first (fast, 8s timeout), then Modrinth (20s timeout).
    // This avoids connection-pool / rate-limit conflicts when both run in parallel.
    const cfRes = await searchCurseForge(query, facets, limit, offset);
    const mrRes = await searchModrinth(query, facets, Math.ceil(limit / 2), offset);

    let cfHits = cfRes.hits || [];
    let mrHits = mrRes.hits || [];

    if (cfRes.error) {
        console.warn('CurseForge search error:', cfRes.error);
    }
    if (mrRes.error) {
        console.warn('Modrinth search error:', mrRes.error);
    }

    // Interleave only if both sources have results, otherwise show whichever succeeded
    let combined;
    if (cfHits.length > 0 && mrHits.length > 0) {
        combined = [];
        const maxLen = Math.max(cfHits.length, mrHits.length);
        for (let i = 0; i < maxLen; i++) {
            if (i < cfHits.length) combined.push(cfHits[i]);
            if (i < mrHits.length) combined.push(mrHits[i]);
        }
    } else {
        combined = cfHits.length > 0 ? cfHits : mrHits;
    }

    return {
        hits: combined.slice(0, limit),
        total_hits: (cfRes.total_hits || 0) + (mrRes.total_hits || 0),
    };
});

async function getCurseForgeModVersion(cfId, loader, mcVersion) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const url = new URL(`${CF_API}/mods/${cfId}/files`);
    if (mcVersion) url.searchParams.append('gameVersion', mcVersion);
    if (loader && CF_LOADER[loader]) url.searchParams.append('modLoaderType', CF_LOADER[loader]);
    url.searchParams.append('pageSize', 1);

    const data = await fetchCachedJSON(url.toString(), { headers: CF_HEADERS, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!data.data || data.data.length === 0) throw new Error(`Keine kompatible CF-Version für ${loader} ${mcVersion} gefunden.`);

    const file = data.data[0];
    return {
        url: file.downloadUrl, filename: file.fileName,
        dependencies: (file.dependencies || []).filter(d => d.relationType === 3).map(d => ({
            dependency_type: 'required', project_id: `cf:${d.modId}`, _cfId: d.modId,
        })),
        // Add version metadata for lock file
        versionId: file.id,
        versionNumber: file.displayName,
        projectId: `cf:${cfId}`,
        source: 'curseforge'
    };
}

async function getModrinthModVersion(slug, loader, mcVersion) {
    const fetchVersions = async (targetLoader) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const url = new URL(`${MODRINTH_API}/project/${slug}/version`);
        if (targetLoader) url.searchParams.append('loaders', JSON.stringify([targetLoader]));
        if (mcVersion) url.searchParams.append('game_versions', JSON.stringify([mcVersion]));

        const versions = await fetchCachedJSON(url.toString(), {
            signal: controller.signal,
            headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' }
        });
        clearTimeout(timeoutId);
        return versions;
    };

    let versions = await fetchVersions(loader);
    if (versions.length === 0 && loader === 'neoforge') {
        versions = await fetchVersions('forge');
    }
    if (versions.length === 0 && loader === 'quilt') {
        versions = await fetchVersions('fabric');
    }
    if (versions.length === 0) throw new Error(`Keine kompatible Version für ${loader} ${mcVersion} gefunden.`);

    const version = versions[0];
    const primaryFile = version.files.find(f => f.primary) || version.files[0];
    return {
        url: primaryFile.url,
        filename: primaryFile.filename,
        dependencies: version.dependencies || [],
        versionId: version.id,
        versionNumber: version.version_number,
        projectId: version.project_id,
        source: 'modrinth'
    };
}

ipcMain.handle('api:getModVersion', async (_e, { slug, loader, mcVersion }) => {
    try {
        if (typeof slug === 'string' && slug.startsWith('cf:')) {
            const cfId = parseInt(slug.replace('cf:', ''));
            return await getCurseForgeModVersion(cfId, loader, mcVersion);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const url = new URL(`${MODRINTH_API}/project/${slug}/version`);
        if (loader) url.searchParams.append('loaders', JSON.stringify([loader]));
        if (mcVersion) url.searchParams.append('game_versions', JSON.stringify([mcVersion]));

        const res = await fetch(url, { 
            signal: controller.signal,
            headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' }
        });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('Fehler beim Abrufen der Mod-Version');
        const versions = await res.json();
        if (versions.length === 0) throw new Error(`Keine kompatible Version für ${loader} ${mcVersion} gefunden.`);
        
        const version = versions[0];
        const primaryFile = version.files.find(f => f.primary) || version.files[0];
        return { 
            url: primaryFile.url, 
            filename: primaryFile.filename, 
            dependencies: version.dependencies || [],
            // Add version metadata for lock file
            versionId: version.id,
            versionNumber: version.version_number,
            projectId: version.project_id,
            source: 'modrinth'
        };
    } catch (e) {
        console.error('getModVersion error:', e);
        throw e; // Rethrow to be caught by renderer
    }
});

ipcMain.handle('api:resolveAllDependencies', async (_e, { modVersionData, loader, mcVersion }) => {
    const toDownload = [{
        url: modVersionData.url,
        filename: modVersionData.filename,
        projectId: modVersionData.projectId,
        source: modVersionData.source,
        versionId: modVersionData.versionId,
        versionNumber: modVersionData.versionNumber
    }];
    const resolvedIds = new Set();
    
    async function resolve(deps) {
        for (const dep of deps) {
            if (dep.dependency_type !== 'required') continue;
            try {
                let vInfo;
                if (dep._cfId) {
                    if (resolvedIds.has(`cf:${dep._cfId}`)) continue;
                    resolvedIds.add(`cf:${dep._cfId}`);
                    vInfo = await getCurseForgeModVersion(dep._cfId, loader, mcVersion);
                } else if (dep.version_id) {
                    if (resolvedIds.has(dep.version_id)) continue;
                    resolvedIds.add(dep.version_id);
                    const res = await fetch(`${MODRINTH_API}/version/${dep.version_id}`, {
                        headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' }
                    });
                    if (!res.ok) continue;
                    const vData = await res.json();
                    vInfo = { url: vData.files[0].url, filename: vData.files[0].filename, dependencies: vData.dependencies || [] };
                } else if (dep.project_id) {
                    if (resolvedIds.has(dep.project_id)) continue;
                    resolvedIds.add(dep.project_id);
                    vInfo = await ipcMain.handle('api:getModVersion', null, { slug: dep.project_id, loader, mcVersion });
                }
                if (vInfo) {
                    toDownload.push({
                        url: vInfo.url,
                        filename: vInfo.filename,
                        projectId: vInfo.projectId,
                        source: vInfo.source,
                        versionId: vInfo.versionId,
                        versionNumber: vInfo.versionNumber
                    });
                    if (vInfo.dependencies?.length > 0) await resolve(vInfo.dependencies);
                }
            } catch (e) { console.warn('Dependency resolution failed for', dep, e); }
        }
    }
    await resolve(modVersionData.dependencies);
    return toDownload;
});

ipcMain.handle('api:getModDetails', async (_e, { slug, source, cfId }) => {
    try {
        if (source === 'curseforge' && cfId) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const [descRes, detailsRes] = await Promise.all([
                    fetch(`${CF_API}/mods/${cfId}/description`, { headers: CF_HEADERS, signal: controller.signal }),
                    fetch(`${CF_API}/mods/${cfId}`, { headers: CF_HEADERS, signal: controller.signal })
                ]);
                clearTimeout(timeout);
                if (!descRes.ok || !detailsRes.ok) {
                    if (detailsRes.ok) {
                        // Description failed, but details succeeded — return what we have
                        const detailsData = await detailsRes.json();
                        return {
                            body: '<p>Keine detaillierte Beschreibung verfügbar.</p>',
                            gallery: detailsData.data.screenshots?.map(s => ({ url: s.url, title: s.title })) || []
                        };
                    }
                    return null;
                }
                const descData = await descRes.json();
                const detailsData = await detailsRes.json();
                return {
                    body: descData.data || '<p>Keine Beschreibung verfügbar.</p>',
                    gallery: detailsData.data.screenshots?.map(s => ({ url: s.url, title: s.title })) || []
                };
            } catch (fetchErr) {
                clearTimeout(timeout);
                if (fetchErr.name === 'AbortError') {
                    console.warn('CurseForge getModDetails timed out for', cfId);
                    return { body: '<p>CurseForge-Beschreibung konnte nicht geladen werden (Timeout).</p>', gallery: [] };
                }
                throw fetchErr;
            }
        } else {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const res = await fetch(`${MODRINTH_API}/project/${slug}`, { 
                    signal: controller.signal,
                    headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' }
                });
                clearTimeout(timeout);
                if (!res.ok) return null;
                const data = await res.json();
                return {
                    body: data.body || data.description || '',
                    gallery: data.gallery?.map(g => ({ url: g.url, title: g.title })) || []
                };
            } catch (fetchErr) {
                clearTimeout(timeout);
                if (fetchErr.name === 'AbortError') {
                    console.warn('Modrinth getModDetails timed out for', slug);
                    return { body: '<p>Beschreibung konnte nicht geladen werden (Timeout).</p>', gallery: [] };
                }
                throw fetchErr;
            }
        }
    } catch (e) {
        console.error('getModDetails error:', e);
        return null;
    }
});

ipcMain.handle('api:getModVersions', async (_e, { slug, source, cfId }) => {
    try {
        if (source === 'curseforge' && cfId) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const url = new URL(`${CF_API}/mods/${cfId}/files`);
                url.searchParams.append('pageSize', 50);
                const res = await fetch(url, { headers: CF_HEADERS, signal: controller.signal });
                clearTimeout(timeout);
                if (!res.ok) return [];
                const data = await res.json();
                const CF_LOADER_MAP = { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };
                return (data.data || []).map(v => ({
                    name: v.displayName,
                    version_number: v.fileName.replace(/\.jar$/, ''),
                    date: v.fileDate,
                    downloads: v.downloadCount,
                    loaders: (v.modLoaders || []).map(l => CF_LOADER_MAP[l]).filter(Boolean),
                    game_versions: v.gameVersions,
                    files: [{ filename: v.fileName, url: v.downloadUrl }],
                    dependencies: (v.dependencies || []).filter(d => d.relationType === 3).map(d => ({
                        dependency_type: 'required', project_id: `cf:${d.modId}`, _cfId: d.modId,
                    })),
                }));
            } catch (fetchErr) {
                clearTimeout(timeout);
                if (fetchErr.name === 'AbortError') {
                    console.warn('CurseForge getModVersions timed out for', cfId);
                    return [];
                }
                throw fetchErr;
            }
        } else { // Modrinth
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const res = await fetch(`${MODRINTH_API}/project/${slug}/version`, { 
                    signal: controller.signal,
                    headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' }
                });
                clearTimeout(timeout);
                if (!res.ok) return [];
                const data = await res.json();
                return data.map(v => ({ ...v, date: v.date_published, dependencies: v.dependencies || [] }));
            } catch (fetchErr) {
                clearTimeout(timeout);
                if (fetchErr.name === 'AbortError') {
                    console.warn('Modrinth getModVersions timed out for', slug);
                    return [];
                }
                throw fetchErr;
            }
        }
    } catch (e) {
        console.error('getModVersions error:', e);
        return [];
    }
});

// ===== AUTH IPC =====
ipcMain.handle('login-microsoft', async () => {
    try {
        // 1. NEU: Session importieren und kompletten Cache/Storage leeren
        const { session } = require('electron');
        await session.defaultSession.clearStorageData({
            storages: ['appcache', 'cookies', 'localstorage', 'sessionstorage']
        });

        // 2. Auth initialisieren 
        const authManager = new Auth('select_account');
        const xboxManager = await authManager.launch('electron');
        const token = await xboxManager.getMinecraft();
        const mclcToken = token.mclc();
        
        saveAuthToken(mclcToken);
        
        // Feature 16: Multi-Account (bleibt unverändert)
        const accounts = loadAccounts();
        const existing = accounts.findIndex(a => a.uuid === mclcToken.uuid);
        const entry = { name: mclcToken.name, uuid: mclcToken.uuid, active: true };
        
        if (existing >= 0) accounts[existing] = { ...accounts[existing], ...entry };
        else accounts.push(entry);
        
        accounts.forEach(a => { a.active = (a.uuid === mclcToken.uuid); });
        saveAccounts(accounts);
        
        return { success: true, name: mclcToken.name, uuid: mclcToken.uuid };
    } catch (error) { 
        return { success: false, error: String(error) }; 
    }
});
ipcMain.handle('get-auth', () => { const t = loadAuthToken(); return t ? { name: t.name, uuid: t.uuid } : null; });
ipcMain.handle('clear-auth', async () => { 
    clearAuthToken(); 
    
    // Den Browser-Cache von Electron zwingend mitlöschen
    const { session } = require('electron');
    await session.defaultSession.clearStorageData({
        storages: ['appcache', 'cookies', 'localstorage', 'sessionstorage']
    });
    
    return true; 
});
ipcMain.handle('get-accounts', () => {
    const accounts = loadAccounts();
    if (accounts.length === 0) {
        const auth = loadAuthToken();
        if (auth) {
            accounts.push({ name: auth.name, uuid: auth.uuid, active: true });
            saveAccounts(accounts);
        }
    }
    return accounts;
});
ipcMain.handle('switch-account', (_e, uuid) => {
    const accounts = loadAccounts();
    const target = accounts.find(a => a.uuid === uuid);
    if (!target) return { success: false, error: 'Account nicht gefunden' };
    accounts.forEach(a => { a.active = (a.uuid === uuid); });
    saveAccounts(accounts);
    return { success: true, name: target.name, uuid: target.uuid };
});
ipcMain.handle('remove-account', (_e, uuid) => { saveAccounts(loadAccounts().filter(a => a.uuid !== uuid)); return { success: true }; });

// ===== PROFILE IPC =====
ipcMain.handle('get-profiles', () => loadProfiles());
ipcMain.handle('save-profiles', (_e, p) => { saveProfiles(p); return true; });
ipcMain.handle('create-profile', async (_e, { name, loader, version, hostMode }) => {
    try {
        if (!name || typeof name !== 'string') return { success: false, error: 'Ungültiger Profilname' };
        const pp = path.join(instancesDir, name);
        if (fs.existsSync(pp)) return { success: false, error: 'Profil existiert bereits' };
        fs.mkdirSync(pp, { recursive: true });
        ['mods','shaderpacks','resourcepacks'].forEach(d => fs.mkdirSync(path.join(pp, d), { recursive: true }));
        const profiles = loadProfiles();
        profiles[name] = { loader, version, ram: null, javaPath: '', jvmArgs: '', jvmPreset: 'default', hostMode: hostMode || 'none' };
        saveProfiles(profiles);
        return { success: true };
    } catch (err) {
        console.error('[create-profile ERROR]:', err);
        return { success: false, error: err.message || 'Fehler beim Erstellen des Profils' };
    }
});
ipcMain.handle('delete-profile', (_e, name) => {
    try {
        const pp = path.join(instancesDir, name);
        if (fs.existsSync(pp)) fs.rmSync(pp, { recursive: true, force: true });
        const profiles = loadProfiles(); delete profiles[name]; saveProfiles(profiles);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('duplicate-profile', (_e, { source, newName }) => {
    const s = path.join(instancesDir, source), d = path.join(instancesDir, newName);
    if (!fs.existsSync(s) || fs.existsSync(d)) return { success: false, error: 'Quelle fehlt oder Ziel existiert bereits' };
    try { fs.cpSync(s, d, { recursive: true }); const p = loadProfiles(); p[newName] = { ...p[source] }; saveProfiles(p); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('open-profile-folder', (_e, name) => { const pp = path.join(instancesDir, name); if (fs.existsSync(pp)) shell.openPath(pp); });

// ===== EXPORT/IMPORT (Feature 19) =====
ipcMain.handle('export-profile', async (_e, name) => {
    const srcPath = path.join(instancesDir, name);
    if (!fs.existsSync(srcPath)) return { success: false, error: 'Profil nicht gefunden.' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Profil exportieren', defaultPath: `${name}.zip`, filters: [{ name: 'Schleimy Modpack', extensions: ['zip'] }, { name: 'Modrinth Pack', extensions: ['mrpack'] }] });
    if (canceled || !filePath) return { success: false, canceled: true };
    try {
        const zip = new AdmZip();
        for (const entry of fs.readdirSync(srcPath)) {
            if (['versions','assets','libraries','runtime'].includes(entry)) continue;
            const full = path.join(srcPath, entry);
            if (fs.statSync(full).isDirectory()) zip.addLocalFolder(full, entry); else zip.addLocalFile(full);
        }
        const profiles = loadProfiles();
        if (profiles[name]) zip.addFile('schleimy-metadata.json', Buffer.from(JSON.stringify({ ...profiles[name], exportedAt: new Date().toISOString(), launcherVersion: '4.0.0' })));
        zip.writeZip(filePath);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('import-profile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Profil importieren', properties: ['openFile'], filters: [{ name: 'Modpacks', extensions: ['zip','mrpack'] }] });
    if (canceled || filePaths.length === 0) return { success: false, canceled: true };
    const zipPath = filePaths[0];
    try {
        const zip = new AdmZip(zipPath);
        const metaEntry = zip.getEntry('schleimy-metadata.json');
        const mrpackIndex = zip.getEntry('modrinth.index.json');
        const cfManifest = zip.getEntry('manifest.json');
        
        const baseName = path.basename(zipPath, path.extname(zipPath));
        let newName = baseName, counter = 1;
        const profiles = loadProfiles();
        while (profiles[newName] || fs.existsSync(path.join(instancesDir, newName))) newName = `${baseName} (${counter++})`;
        const destPath = path.join(instancesDir, newName);
        fs.mkdirSync(destPath, { recursive: true });
        zip.extractAllTo(destPath, true);
        
        // Helper to move overrides
        const moveOverrides = (folderName) => {
            const ovPath = path.join(destPath, folderName);
            if (fs.existsSync(ovPath)) {
                const copyRecursive = (src, dest) => {
                    if (fs.statSync(src).isDirectory()) {
                        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                        fs.readdirSync(src).forEach(item => copyRecursive(path.join(src, item), path.join(dest, item)));
                    } else {
                        fs.renameSync(src, dest);
                    }
                };
                fs.readdirSync(ovPath).forEach(item => copyRecursive(path.join(ovPath, item), path.join(destPath, item)));
                fs.rmSync(ovPath, { recursive: true, force: true });
            }
        };

        const mf = path.join(destPath, 'schleimy-metadata.json');
        if (fs.existsSync(mf)) fs.unlinkSync(mf);
        
        if (metaEntry) {
            // Schleimy Pack
            profiles[newName] = JSON.parse(zip.readAsText(metaEntry));
        } else if (mrpackIndex) {
            // Modrinth Pack
            const mrData = JSON.parse(zip.readAsText(mrpackIndex));
            const deps = mrData.dependencies || {};
            let loader = 'vanilla';
            if (deps['fabric-loader']) loader = 'fabric'; else if (deps['forge']) loader = 'forge'; else if (deps['neoforge']) loader = 'neoforge'; else if (deps['quilt-loader']) loader = 'quilt';
            
            profiles[newName] = { loader, version: deps['minecraft'] || '1.20.1', ram: null, javaPath: '', jvmArgs: '', jvmPreset: 'default' };
            
            moveOverrides('overrides');
            moveOverrides('client-overrides');
            
            if (mrData.files) {
                for (const file of mrData.files) { 
                    try { 
                        if (file.downloads?.[0]) { 
                            const r = await fetch(file.downloads[0]); 
                            if (r.ok) { 
                                const b = await r.arrayBuffer(); 
                                const fp = path.join(destPath, file.path); 
                                fs.mkdirSync(path.dirname(fp), { recursive: true }); 
                                fs.writeFileSync(fp, Buffer.from(b)); 
                            } 
                        } 
                    } catch (_) {} 
                }
            }
        } else if (cfManifest) {
            // CurseForge Pack
            const cfData = JSON.parse(zip.readAsText(cfManifest));
            let loader = 'vanilla';
            let version = '1.20.1';
            
            if (cfData.minecraft) {
                version = cfData.minecraft.version || version;
                const ml = cfData.minecraft.modLoaders;
                if (ml && ml.length > 0) {
                    const lId = ml[0].id.toLowerCase();
                    if (lId.includes('fabric')) loader = 'fabric';
                    else if (lId.includes('forge')) loader = 'forge';
                    else if (lId.includes('neoforge')) loader = 'neoforge';
                    else if (lId.includes('quilt')) loader = 'quilt';
                }
            }
            
            profiles[newName] = { loader, version, ram: null, javaPath: '', jvmArgs: '', jvmPreset: 'default' };
            
            moveOverrides(cfData.overrides || 'overrides');
            
            // Note: Downloading CF mods without API key is restricted. 
            // We rely on overrides containing the necessary configs/mods or the user dropping them in.
        } else {
            // Unknown zip
            profiles[newName] = { loader: 'forge', version: '1.20.1', ram: null, javaPath: '', jvmArgs: '', jvmPreset: 'default' };
        }
        
        // Cleanup manifest files
        ['modrinth.index.json', 'manifest.json'].forEach(f => {
            const fp = path.join(destPath, f);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        });

        saveProfiles(profiles);
        return { success: true, newName };
    } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('export-mrpack', async (_e, { name, packName, packVersion, packDescription }) => {
    const srcPath = path.join(instancesDir, name);
    if (!fs.existsSync(srcPath)) return { success: false, error: 'Profil nicht gefunden.' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Als Modrinth Pack exportieren', defaultPath: `${name}.mrpack`, filters: [{ name: 'Modrinth Pack', extensions: ['mrpack'] }] });
    if (canceled || !filePath) return { success: false, canceled: true };
    try {
        const zip = new AdmZip();
        const profiles = loadProfiles();
        const profile = profiles[name] || {};
        const deps = { minecraft: profile.version || '1.20.1' };
        if (profile.loader === 'fabric') deps['fabric-loader'] = '*';
        if (profile.loader === 'forge') deps['forge'] = '*';
        const index = { formatVersion: 1, game: 'minecraft', versionId: packVersion || '1.0.0', name: packName || name, summary: packDescription || '', files: [], dependencies: deps };
        const addOverrides = (dir, prefix) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir)) { if (['versions','assets','libraries','runtime'].includes(e)) continue; const f = path.join(dir, e), r = prefix ? `${prefix}/${e}` : e; if (fs.statSync(f).isDirectory()) addOverrides(f, r); else zip.addFile(`overrides/${r}`, fs.readFileSync(f)); } };
        addOverrides(srcPath, '');
        zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));
        zip.writeZip(filePath);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// ===== MODS IPC =====
ipcMain.handle('get-installed-mods', (_e, profileName) => {
    const mp = path.join(instancesDir, profileName, 'mods');
    if (!fs.existsSync(mp)) return [];
    // Read lock file to attach projectId (slug) to each mod for reliable matching in discover tab
    const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
    const lockFile = loadJSON(lockFilePath, { mods: {} });
    try {
        return fs.readdirSync(mp).filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled')).map(f => {
            const s = fs.statSync(path.join(mp, f));
            const lockEntry = lockFile.mods[f];
            return {
                filename: f,
                displayName: f.replace('.jar.disabled','').replace('.jar',''),
                enabled: !f.endsWith('.disabled'),
                size: s.size,
                modified: s.mtime.toISOString(),
                projectId: lockEntry ? lockEntry.projectId : null
            };
        });
    } catch (_) { return []; }
});
ipcMain.handle('toggle-mod', (_e, { profileName, filename }) => {
    const dir = path.join(instancesDir, profileName, 'mods');
    const res = toggleFile(dir, filename);
    if (res.success) { // Update lock file key
        const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
        if (fs.existsSync(lockFilePath)) {
            const lockFile = loadJSON(lockFilePath, { mods: {} });
            const modData = lockFile.mods[filename];
            if (modData) {
                delete lockFile.mods[filename];
                lockFile.mods[res.newFilename] = modData;
                saveJSON(lockFilePath, lockFile);
            }
        }
    }
    return res;
});
ipcMain.handle('delete-mod', (_e, { profileName, filename }) => {
    const dir = path.join(instancesDir, profileName, 'mods');
    const res = deleteFile(dir, filename);
    if (res.success) { // Remove from lock file
        const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
        if (fs.existsSync(lockFilePath)) {
            const lockFile = loadJSON(lockFilePath, { mods: {} });
            delete lockFile.mods[filename];
            saveJSON(lockFilePath, lockFile);
        }
    }
    return res;
});

// Feature 4: Shader & Resource Pack Management
ipcMain.handle('get-shaderpacks', (_e, pn) => listContentDir(path.join(instancesDir, pn, 'shaderpacks'), '.zip'));
ipcMain.handle('get-resourcepacks', (_e, pn) => listContentDir(path.join(instancesDir, pn, 'resourcepacks'), '.zip'));
ipcMain.handle('toggle-shaderpack', (_e, { profileName, filename }) => toggleFile(path.join(instancesDir, profileName, 'shaderpacks'), filename));
ipcMain.handle('toggle-resourcepack', (_e, { profileName, filename }) => toggleFile(path.join(instancesDir, profileName, 'resourcepacks'), filename));
ipcMain.handle('delete-shaderpack', (_e, { profileName, filename }) => deleteFile(path.join(instancesDir, profileName, 'shaderpacks'), filename));
ipcMain.handle('delete-resourcepack', (_e, { profileName, filename }) => deleteFile(path.join(instancesDir, profileName, 'resourcepacks'), filename));

function listContentDir(dir, ext) {
    if (!fs.existsSync(dir)) return [];
    try { return fs.readdirSync(dir).filter(f => f.endsWith(ext) || f.endsWith(ext + '.disabled')).map(f => ({ filename: f, displayName: f.replace(ext + '.disabled','').replace(ext,''), enabled: !f.endsWith('.disabled'), size: fs.statSync(path.join(dir, f)).size })); } catch (_) { return []; }
}
function toggleFile(dir, filename) {
    try { const n = filename.endsWith('.disabled') ? filename.replace('.disabled','') : filename + '.disabled'; fs.renameSync(path.join(dir, filename), path.join(dir, n)); return { success: true, newFilename: n, enabled: filename.endsWith('.disabled') }; }
    catch (e) { return { success: false, error: e.message }; }
}
function deleteFile(dir, filename) {
    try { const fp = path.join(dir, filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
}

function disableModFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const disabledPath = `${filePath}.disabled`;
    if (fs.existsSync(disabledPath)) return false;
    fs.renameSync(filePath, disabledPath);
    return true;
}

async function downloadModFile(opts) {
    const profileName = opts.profileName;
    const fileName = opts.fileName || opts.filename;
    const downloadUrl = opts.downloadUrl || opts.url;
    const targetDir = opts.targetDir || 'mods';
    const projectId = opts.projectId;
    const source = opts.source;
    const versionId = opts.versionId;
    const versionNumber = opts.versionNumber;
    if (!profileName || typeof profileName !== 'string') return { success: false, error: 'Ungültiger Profilname', fileName };
    if (!fileName || typeof fileName !== 'string') return { success: false, error: 'Ungültiger Dateiname', fileName };
    if (!downloadUrl || typeof downloadUrl !== 'string') return { success: false, error: 'Ungültige Download-URL', fileName };

    const unsafeName = path.basename(fileName);
    const safeName = unsafeName
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+$/g, '')
        .replace(/^\.+/, '') || unsafeName;
    const finalName = safeName || `mod-${Date.now()}.jar`;

    const tp = path.join(instancesDir, profileName, targetDir);
    if (!fs.existsSync(tp)) fs.mkdirSync(tp, { recursive: true });
    const filePath = path.join(tp, finalName);
    try {
        sendEvent('download-progress', `${finalName} wird heruntergeladen...`, { fileName: finalName, progress: 0 });
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        sendEvent('download-progress', `${finalName}`, { fileName: finalName, progress: 100 });
        if (targetDir === 'mods' && (projectId || versionId)) {
            const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
            const lockFile = loadJSON(lockFilePath, { mods: {} });
            lockFile.mods[finalName] = { projectId: projectId || null, source: source || 'modrinth', versionId: versionId || null, versionNumber: versionNumber || null };
            saveJSON(lockFilePath, lockFile);
        }
        sendEvent('download-complete', `${finalName} installiert.`, { fileName: finalName });
        return { success: true, fileName: finalName, filePath };
    } catch (error) {
        sendEvent('download-error', `${finalName}: ${error.message}`, { fileName: finalName, error: error.message });
        return { success: false, error: error.message, fileName: finalName };
    }
}

ipcMain.on('download-mod', async (_e, data) => {
    const result = await downloadModFile(data);
    if (result.success) {
        sendEvent('success', `${result.fileName} erfolgreich installiert!`, { 
            fileName: result.fileName, 
            projectId: data.projectId,
            profileName: data.profileName,
            targetDir: data.targetDir
        });
    } else {
        sendEvent('error', `Download fehlgeschlagen: ${result.error}`, { fileName: result.fileName });
    }
});

const SYSTEM_DEP_IDS = new Set([
    'minecraft', 'java', 'fabricloader', 'fabric-loader', 'forge', 'neoforge', 
    'quilt_loader', 'quilt-loader', 'c', 'fabric', 'quilt', 'modmenu', 
    'forge-loader', 'neoforge-loader', 'mc', 'kotlin_for_forge', 'kotlinforforge',
    'fabric-language-kotlin', 'forge_loader', 'neoforge_loader', 'quilt_base'
]);

function isIgnoredDependency(depId, loader) {
    if (!depId) return true;
    const clean = String(depId).toLowerCase();
    if (SYSTEM_DEP_IDS.has(clean)) return true;
    if ((loader === 'neoforge' || loader === 'forge') && (clean === 'fabric-api' || clean === 'fabric_api' || clean === 'optifabric' || clean === 'fabric-language-kotlin' || clean === 'cloth-basic-math' || clean === 'sodium-options-api')) {
        return true;
    }
    return false;
}

// Feature 3: Fix mod conflicts and install missing dependencies
ipcMain.handle('fix-mod-conflicts', async (_e, { profileName, loader, mcVersion }) => {
    const mp = path.join(instancesDir, profileName, 'mods');
    if (!fs.existsSync(mp)) return { conflicts: [], missing: [], disabled: [], installed: [], updated: [], activated: [], errors: [], unchecked: [] };

    const allFiles = fs.readdirSync(mp);
    const mods = allFiles.filter(f => f.endsWith('.jar'));
    const disabledFiles = allFiles.filter(f => f.endsWith('.jar.disabled'));
    const conflicts = [];
    const missing = [];
    const disabled = [];
    const installed = [];
    const updated = [];
    const activated = [];
    const errors = [];
    const unchecked = [];
    const seenProjects = new Set();
    const seenVersions = new Set();
    const disabledModsMap = new Map();
    const crypto = require('crypto');
    const missingProjectIds = new Map();

    for (const df of disabledFiles) {
        const dfPath = path.join(mp, df);
        const cleanName = df.replace(/\.jar\.disabled$/i, '').replace(/[-_v0-9+.]+$/g, '').toLowerCase();
        disabledModsMap.set(cleanName, df);
        disabledModsMap.set(`name:${cleanName}`, df);
        try {
            const jarInfo = parseJarForDependencies(dfPath);
            if (jarInfo && jarInfo.modIds) {
                for (const mid of jarInfo.modIds) {
                    if (mid) {
                        const cleanMid = mid.toLowerCase();
                        disabledModsMap.set(cleanMid, df);
                        disabledModsMap.set(`jar:${cleanMid}`, df);
                        disabledModsMap.set(`name:${cleanMid}`, df);
                    }
                }
            }
        } catch (_) {}
    }

    const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
    const lockFile = fs.existsSync(lockFilePath) ? loadJSON(lockFilePath, { mods: {} }) : { mods: {} };
    for (const [key, meta] of Object.entries(lockFile.mods || {})) {
        if (!meta) continue;
        const fname = meta.fileName || meta.filename || '';
        const isDisabledOnDisk = disabledFiles.includes(`${fname}.disabled`) || disabledFiles.includes(fname) || fname.endsWith('.disabled');
        if (isDisabledOnDisk) {
            const dfName = fname.endsWith('.disabled') ? fname : `${fname}.disabled`;
            if (meta.projectId) disabledModsMap.set(meta.projectId.toLowerCase(), dfName);
            if (meta.versionId) disabledModsMap.set(meta.versionId.toLowerCase(), dfName);
            if (meta.cfId) disabledModsMap.set(`cf:${meta.cfId}`, dfName);
        }
    }

    function checkAndActivateIfDisabled(key) {
        if (!key) return false;
        const lookup = String(key).toLowerCase();
        let dfName = disabledModsMap.get(lookup) || disabledModsMap.get(lookup.replace(/^jar:/, '')) || disabledModsMap.get(`jar:${lookup}`);
        if (!dfName) {
            for (const [mKey, mVal] of disabledModsMap.entries()) {
                if (mKey === lookup || mKey === `jar:${lookup}` || mVal.toLowerCase().includes(lookup)) {
                    dfName = mVal;
                    break;
                }
            }
        }
        if (dfName) {
            const disabledPath = path.join(mp, dfName);
            const enabledName = dfName.replace('.jar.disabled', '.jar');
            const enabledPath = path.join(mp, enabledName);
            if (fs.existsSync(disabledPath)) {
                try {
                    fs.renameSync(disabledPath, enabledPath);
                    activated.push(enabledName);
                    seenProjects.add(key);
                    seenProjects.add(lookup);
                    seenProjects.add(`jar:${lookup}`);
                    disabledModsMap.delete(lookup);
                    return true;
                } catch (err) {}
            }
        }
        return false;
    }

    async function resolveProjectVersion(projectId) {
        try {
            if (typeof projectId === 'string' && projectId.startsWith('cf:')) {
                const cfId = parseInt(projectId.replace('cf:', ''), 10);
                return await getCurseForgeModVersion(cfId, loader, mcVersion);
            }
            if (typeof projectId === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(projectId)) {
                const res = await fetch(`${MODRINTH_API}/version/${projectId}`, { headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' } });
                if (!res.ok) throw new Error(`Modrinth-Version ${projectId} konnte nicht geladen werden.`);
                const version = await res.json();
                const primaryFile = (version.files || []).find(f => f.primary) || (version.files || [])[0];
                return {
                    url: primaryFile?.url,
                    filename: primaryFile?.filename,
                    dependencies: version.dependencies || [],
                    versionId: version.id,
                    versionNumber: version.version_number,
                    projectId: version.project_id,
                    source: 'modrinth'
                };
            }
            return await getModrinthModVersion(projectId, loader, mcVersion);
        } catch (e) {
            return null;
        }
    }

    async function searchModByDepName(depName) {
        if (isIgnoredDependency(depName, loader)) return null;
        const searchVariants = [depName];
        const cleaned = depName.replace(/-(fabric|forge|neoforge|quilt|mc\d+.*|\d+\.\d+.*)$/i, '')
                               .replace(/_(fabric|forge|neoforge|quilt|mc\d+.*|\d+\.\d+.*)$/i, '');
        if (cleaned !== depName) searchVariants.push(cleaned);
        if (/^\d+$/.test(depName)) searchVariants.push(depName);

        for (const variant of searchVariants) {
            if (/^[a-zA-Z0-9_-]+$/.test(variant)) {
                try {
                    const prRes = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(variant)}`, {
                        headers: { 'User-Agent': 'SchleimyLauncher/6.0.0' }
                    });
                    if (prRes.ok) {
                        const prData = await prRes.json();
                        if (prData.slug) return prData.slug;
                    }
                } catch (_) {}
            }
        }

        for (const variant of searchVariants) {
            try {
                const mrRes = await fetch(`${MODRINTH_API}/search?query=${encodeURIComponent(variant)}&limit=10&facets=${encodeURIComponent(JSON.stringify([['project_type:mod']]))}`, {
                    headers: { 'User-Agent': 'SchleimyLauncher/6.0.0' }
                });
                if (mrRes.ok) {
                    const mrData = await mrRes.json();
                    if (mrData.hits && mrData.hits.length > 0) {
                        for (const hit of mrData.hits) {
                            if (!loader || hit.categories.includes(loader)) return hit.slug;
                        }
                        return mrData.hits[0].slug;
                    }
                }
            } catch (_) {}

            try {
                if (CF_API_KEY) {
                    const cfRes = await fetch(`${CF_API}/mods/search?gameId=${CF_GAME_ID}&searchFilter=${encodeURIComponent(variant)}&classId=${CF_CLASS.mod}&pageSize=5`, { headers: CF_HEADERS });
                    if (cfRes.ok) {
                        const cfData = await cfRes.json();
                        if (cfData.data && cfData.data.length > 0) return `cf:${cfData.data[0].id}`;
                    }
                }
            } catch (_) {}
        }

        return null;
    }

    // PASS 1: Read all jars first and populate seenProjects / seenModIds
    const parsedMods = [];
    for (const mod of mods) {
        const modPath = path.join(mp, mod);
        let foundModIds = [];
        let jarDeps = {};
        let vData = null;

        try {
            const jarInfo = parseJarForDependencies(modPath);
            if (jarInfo) {
                foundModIds = jarInfo.modIds || [];
                jarDeps = jarInfo.dependencies || {};
                for (const mid of foundModIds) {
                    if (mid) {
                        seenProjects.add(`jar:${mid.toLowerCase()}`);
                        seenProjects.add(mid.toLowerCase());
                    }
                }
            }
        } catch (e) {}

        try {
            const sha1 = crypto.createHash('sha1').update(fs.readFileSync(modPath)).digest('hex');
            const shaRes = await fetch(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
            if (shaRes.ok) {
                vData = await shaRes.json();
                const projectId = vData.project_id;
                const versionId = vData.id;
                if (projectId) {
                    if (seenProjects.has(projectId)) {
                        conflicts.push({ type: 'duplicate', message: `Doppelte Mod: ${mod}`, files: [mod] });
                        if (disableModFile(modPath)) disabled.push(mod);
                        continue;
                    }
                    seenProjects.add(projectId);
                    seenProjects.add(projectId.toLowerCase());
                }
                if (versionId) seenVersions.add(versionId);
                if (!vData.game_versions?.includes(mcVersion)) {
                    conflicts.push({ type: 'version', message: `${mod} ist nicht für MC ${mcVersion} verifiziert - automatische Korrektur wird versucht.`, files: [mod], projectId: vData.project_id });
                    if (vData.project_id) {
                        try {
                            const fixedVer = await getModrinthModVersion(vData.project_id, loader, mcVersion);
                            if (fixedVer && fixedVer.url && fixedVer.filename !== mod) {
                                await downloadModFile({
                                    downloadUrl: fixedVer.url,
                                    fileName: fixedVer.filename,
                                    profileName,
                                    projectId: vData.project_id,
                                    source: 'modrinth',
                                    versionId: fixedVer.versionId,
                                    versionNumber: fixedVer.versionNumber
                                });
                                installed.push(fixedVer.filename);
                                if (disableModFile(modPath)) disabled.push(mod);
                            }
                        } catch (_) {}
                    }
                }
                if (!vData.loaders?.includes(loader)) {
                    conflicts.push({ type: 'loader', message: `${mod} unterstützt ${loader} nicht.`, files: [mod], projectId: vData.project_id });
                }
            }
        } catch (e) {}

        const cleanName = mod.replace(/\.jar$/i, '').replace(/[-_v0-9+.]+$/g, '').toLowerCase();
        if (cleanName) seenProjects.add(cleanName);

        parsedMods.push({ mod, modPath, vData, jarDeps });
    }

    // INCOMPATIBILITY CHECK
    let hasIris = false;
    let embeddiumMod = null;
    let embeddiumPath = null;
    for (const pm of parsedMods) {
        const mids = pm.foundModIds || [];
        if (mids.includes('iris') || pm.mod.toLowerCase().includes('iris-')) hasIris = true;
        if (mids.includes('embeddium') || pm.mod.toLowerCase().includes('embeddium')) {
            embeddiumMod = pm.mod;
            embeddiumPath = pm.modPath;
        }
    }
    if (hasIris && embeddiumMod && embeddiumPath) {
        if (disableModFile(embeddiumPath)) {
            disabled.push(embeddiumMod);
            conflicts.push({ type: 'incompatible', message: `Embeddium ist inkompatibel mit Iris - durch Sodium ersetzt`, files: [embeddiumMod] });
        }
    }

    for (const pm of parsedMods) {
        for (const dep of (pm.vData?.dependencies || [])) {
            if (dep.dependency_type === 'incompatible') {
                const incId = dep.project_id || dep.version_id;
                if (!incId) continue;
                for (const target of parsedMods) {
                    if (target.vData?.project_id === incId || target.vData?.id === incId) {
                        if (disableModFile(target.modPath)) {
                            disabled.push(target.mod);
                            conflicts.push({ type: 'incompatible', message: `${target.mod} ist inkompatibel mit ${pm.mod}`, files: [target.mod, pm.mod] });
                        }
                    }
                }
            }
        }
    }

    // PASS 2: Check required dependencies against complete seenProjects
    for (const { mod, vData, jarDeps } of parsedMods) {
        const requiredDepNames = new Set();
        for (const [depModId, depEntries] of Object.entries(jarDeps)) {
            if (isIgnoredDependency(depModId, loader)) continue;
            for (const entry of depEntries) {
                if (entry.mandatory !== false) {
                    requiredDepNames.add(depModId);
                }
            }
        }

        for (const dep of (vData?.dependencies || [])) {
            if (dep.dependency_type === 'required') {
                const depKey = dep._cfId ? `cf:${dep._cfId}` : dep.version_id || dep.project_id;
                if (!depKey) continue;
                const cleanKey = String(depKey).toLowerCase();
                if (isIgnoredDependency(cleanKey, loader)) continue;
                const depInstalled = (dep.project_id && (seenProjects.has(dep.project_id) || seenProjects.has(dep.project_id.toLowerCase()))) ||
                    (dep.version_id && seenVersions.has(dep.version_id)) ||
                    (dep._cfId && seenProjects.has(`cf:${dep._cfId}`));
                if (depInstalled) continue;
                if (checkAndActivateIfDisabled(dep.project_id) || checkAndActivateIfDisabled(dep.version_id) || checkAndActivateIfDisabled(dep._cfId ? `cf:${dep._cfId}` : null)) {
                    continue;
                }
                if (missingProjectIds.has(depKey)) continue;
                missingProjectIds.set(depKey, {
                    requiredBy: mod,
                    projectId: dep.project_id,
                    versionId: dep.version_id,
                    cfId: dep._cfId,
                });
                requiredDepNames.add(depKey);
            }
        }

        for (const depModId of requiredDepNames) {
            if (isIgnoredDependency(depModId, loader)) continue;
            if (seenProjects.has(`jar:${depModId.toLowerCase()}`) || seenProjects.has(depModId.toLowerCase())) continue;
            if (checkAndActivateIfDisabled(depModId) || checkAndActivateIfDisabled(`name:${depModId}`)) continue;
            if (missingProjectIds.has(`name:${depModId}`)) continue;

            const slug = await searchModByDepName(depModId);
            if (slug) {
                if (seenProjects.has(slug) || seenProjects.has(slug.toLowerCase())) continue;
                missingProjectIds.set(`name:${depModId}`, {
                    requiredBy: mod,
                    projectId: slug,
                    versionId: null,
                    cfId: slug.startsWith('cf:') ? parseInt(slug.replace('cf:', ''), 10) : null,
                    depName: depModId,
                });
            } else {
                missing.push({ requiredBy: mod, projectId: depModId, projectName: depModId, unresolved: true });
            }
        }

        if (!vData && Object.keys(jarDeps).length === 0) {
            unchecked.push(mod);
        }
    }

    async function resolveDependencyVersion(depEntry) {
        if (depEntry?.cfId) {
            return await getCurseForgeModVersion(depEntry.cfId, loader, mcVersion);
        }
        if (depEntry?.versionId) {
            const res = await fetch(`${MODRINTH_API}/version/${depEntry.versionId}`, { headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' } });
            if (!res.ok) throw new Error(`Modrinth-Version ${depEntry.versionId} konnte nicht geladen werden.`);
            const vData = await res.json();
            const primaryFile = (vData.files || []).find(f => f.primary) || (vData.files || [])[0];
            return {
                url: primaryFile?.url,
                filename: primaryFile?.filename,
                dependencies: vData.dependencies || [],
                versionId: vData.id,
                versionNumber: vData.version_number,
                projectId: vData.project_id,
                source: 'modrinth'
            };
        }
        if (depEntry?.projectId) {
            return await resolveProjectVersion(depEntry.projectId);
        }
        throw new Error('Unbekannter Abhängigkeitstyp');
    }

    // PASS 3: Download missing dependencies and recursively install their sub-dependencies
    for (const [projectId, depInfo] of missingProjectIds.entries()) {
        const checkKey = depInfo.projectId || depInfo.depName || projectId;
        if (seenProjects.has(checkKey) || seenProjects.has(String(checkKey).toLowerCase())) continue;
        try {
            const versionInfo = await resolveDependencyVersion(depInfo);
            if (!versionInfo) {
                missing.push({ ...depInfo, projectName: depInfo.projectId || depInfo.versionId || `Abhängigkeit ${projectId}` });
                continue;
            }
            const downloads = await (async () => {
                const toDownload = [{
                    url: versionInfo.url,
                    filename: versionInfo.filename,
                    projectId: versionInfo.projectId,
                    source: versionInfo.source,
                    versionId: versionInfo.versionId,
                    versionNumber: versionInfo.versionNumber
                }];
                const resolvedIds = new Set();

                async function resolve(dependencies) {
                    for (const dep of dependencies || []) {
                        if (dep.dependency_type !== 'required') continue;
                        const depKey = dep._cfId ? `cf:${dep._cfId}` : dep.version_id || dep.project_id;
                        if (!depKey || resolvedIds.has(depKey)) continue;
                        if (isIgnoredDependency(depKey, loader)) continue;
                        if (seenProjects.has(String(depKey).toLowerCase())) continue;
                        resolvedIds.add(depKey);
                        let nestedVersion = null;
                        try {
                            if (dep._cfId) {
                                nestedVersion = await getCurseForgeModVersion(dep._cfId, loader, mcVersion);
                            } else if (dep.version_id) {
                                const res = await fetch(`${MODRINTH_API}/version/${dep.version_id}`, { headers: { 'User-Agent': 'SchleimyLauncher/6.0.0 (github.com/Schleimy007/schleimy-launcher)' } });
                                if (res.ok) {
                                    const vData = await res.json();
                                    nestedVersion = {
                                        url: vData.files[0]?.url,
                                        filename: vData.files[0]?.filename,
                                        dependencies: vData.dependencies || [],
                                        versionId: vData.id,
                                        versionNumber: vData.version_number,
                                        projectId: vData.project_id,
                                        source: 'modrinth'
                                    };
                                }
                            } else if (dep.project_id) {
                                nestedVersion = await getModrinthModVersion(dep.project_id, loader, mcVersion);
                            }
                        } catch (nestedErr) {}
                        if (nestedVersion) {
                            toDownload.push({
                                url: nestedVersion.url,
                                filename: nestedVersion.filename,
                                projectId: nestedVersion.projectId,
                                source: nestedVersion.source,
                                versionId: nestedVersion.versionId,
                                versionNumber: nestedVersion.versionNumber
                            });
                            await resolve(nestedVersion.dependencies || []);
                        }
                    }
                }
                await resolve(versionInfo.dependencies || []);
                return toDownload;
            })();

            const uniqueDownloads = [];
            const seenFiles = new Set();
            for (const item of downloads) {
                if (!item || !item.filename || !item.url) continue;
                if (!seenFiles.has(item.filename)) {
                    seenFiles.add(item.filename);
                    uniqueDownloads.push(item);
                }
            }

            for (const item of uniqueDownloads) {
                if (seenProjects.has(item.projectId) || seenProjects.has(item.filename.toLowerCase())) continue;
                const res = await downloadModFile({ ...item, profileName });
                if (res.success) {
                    installed.push(item.filename);
                    if (item.projectId) {
                        seenProjects.add(item.projectId);
                        seenProjects.add(String(item.projectId).toLowerCase());
                    }
                    seenProjects.add(item.filename.toLowerCase());
                } else {
                    errors.push(`Installieren von ${item.filename} fehlgeschlagen: ${res.error}`);
                }
            }
        } catch (e) {
            missing.push({ ...depInfo, projectName: projectId });
            if (!e.message.includes('Keine kompatible Version') && !e.message.includes('konnte nicht ermittelt werden')) {
                errors.push(`Installieren fehlender Abhängigkeit ${projectId} fehlgeschlagen: ${e.message}`);
            }
        }
    }

    // Try to update incompatible mods if possible
    for (const conflict of conflicts.filter(c => c.type === 'version' || c.type === 'loader')) {
        const modFile = conflict.files[0];
        try {
            const existingFile = path.join(mp, modFile);
            if (!fs.existsSync(existingFile)) continue;
            const sha1 = crypto.createHash('sha1').update(fs.readFileSync(existingFile)).digest('hex');
            const res = await fetch(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
            if (!res.ok) continue;
            const vData = await res.json();
            const versionInfo = await resolveProjectVersion(vData.project_id);
            if (!versionInfo) continue;
            const newFile = await downloadModFile({
                profileName,
                downloadUrl: versionInfo.url,
                fileName: versionInfo.filename,
                projectId: versionInfo.projectId,
                source: versionInfo.source,
                versionId: versionInfo.versionId,
                versionNumber: versionInfo.versionNumber
            });
            if (newFile.success) {
                if (existingFile !== newFile.filePath && fs.existsSync(existingFile)) fs.unlinkSync(existingFile);
                updated.push(versionInfo.filename);
            }
        } catch (e) {
            errors.push(`Update für ${conflict.files[0]} fehlgeschlagen: ${e.message}`);
        }
    }

    return { conflicts, missing, disabled, installed, updated, activated, errors, unchecked };
});

// Feature 2: Check for mod updates
ipcMain.handle('check-mod-updates', async (_e, { profileName, loader, mcVersion }) => {
    const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
    if (!fs.existsSync(lockFilePath)) return [];

    const lockFile = loadJSON(lockFilePath, {});
    const installedMods = lockFile.mods || {};
    const updates = [];

    for (const filename in installedMods) {
        if (!Object.prototype.hasOwnProperty.call(installedMods, filename)) continue;

        const modPath = path.join(instancesDir, profileName, 'mods', filename);
        if (!fs.existsSync(modPath)) continue; // Skip if file is missing

        const modInfo = installedMods[filename];
        try {
            let latestVersion = null;
            if (modInfo.source === 'modrinth') {
                const res = await fetch(`${MODRINTH_API}/project/${modInfo.projectId}/version?loaders=${JSON.stringify([loader])}&game_versions=${JSON.stringify([mcVersion])}`);
                if (!res.ok) continue;
                const versions = await res.json();
                if (versions.length > 0) {
                    latestVersion = versions[0];
                }
            } else if (modInfo.source === 'curseforge') {
                const cfId = modInfo.projectId.startsWith('cf:') ? modInfo.projectId.substring(3) : modInfo.projectId;
                const url = new URL(`${CF_API}/mods/${cfId}/files`);
                url.searchParams.append('gameVersion', mcVersion);
                if (CF_LOADER[loader]) url.searchParams.append('modLoaderType', CF_LOADER[loader]);
                url.searchParams.append('pageSize', 1);
                const res = await fetch(url, { headers: CF_HEADERS });
                if (!res.ok) continue;
                const cfData = await res.json();
                if (cfData.data && cfData.data.length > 0) {
                    const file = cfData.data[0];
                    latestVersion = {
                        id: file.id,
                        project_id: modInfo.projectId,
                        version_number: file.displayName,
                        name: file.displayName,
                        files: [{ url: file.downloadUrl, filename: file.fileName }]
                    };
                }
            }

            if (latestVersion && latestVersion.id !== modInfo.versionId) {
                const latestFile = latestVersion.files.find(f => f.primary) || latestVersion.files[0];
                updates.push({
                    currentFile: filename,
                    projectName: latestVersion.name || modInfo.projectId,
                    currentVersion: modInfo.versionNumber,
                    latestVersion: latestVersion.version_number,
                    downloadUrl: latestFile.url,
                    newFilename: latestFile.filename,
                    newMeta: {
                        projectId: modInfo.projectId,
                        source: modInfo.source,
                        versionId: latestVersion.id,
                        versionNumber: latestVersion.version_number
                    }
                });
            }
        } catch (e) {
            console.warn(`Update check for ${filename} failed:`, e);
        }
    }
    return updates;
});
ipcMain.handle('update-mod', async (_e, { profileName, currentFile, downloadUrl, newFilename, newMeta }) => {
    const mp = path.join(instancesDir, profileName, 'mods');
    try { 
        if (!fs.existsSync(mp)) fs.mkdirSync(mp, { recursive: true });
        const res = await fetch(downloadUrl); 
        if (!res.ok) throw new Error(`HTTP ${res.status}`); 
        fs.writeFileSync(path.join(mp, newFilename), Buffer.from(await res.arrayBuffer())); 
        const old = path.join(mp, currentFile); 
        if (fs.existsSync(old) && currentFile !== newFilename) fs.unlinkSync(old);

        // Update lock file
        const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
        if (fs.existsSync(lockFilePath) && newMeta) {
            const lockFile = loadJSON(lockFilePath, { mods: {} });
            delete lockFile.mods[currentFile];
            lockFile.mods[newFilename] = newMeta;
            saveJSON(lockFilePath, lockFile);
        }

        return { success: true }; 
    }
    catch (e) { return { success: false, error: e.message }; }
});

// Feature 3: Mod Conflict Checker
ipcMain.handle('check-mod-conflicts', async (_e, { profileName, loader, mcVersion }) => {
    const mp = path.join(instancesDir, profileName, 'mods');
    if (!fs.existsSync(mp)) return { conflicts: [], missing: [], unchecked: [] };

    const lockFilePath = path.join(instancesDir, profileName, 'schleimy-lock.json');
    const lockFile = fs.existsSync(lockFilePath) ? loadJSON(lockFilePath, { mods: {} }) : { mods: {} };
    const seenProjects = new Set();
    const seenVersions = new Set();
    const conflicts = [];
    const missing = [];
    const unchecked = [];

    const allFiles = fs.readdirSync(mp);
    const mods = allFiles.filter(f => f.endsWith('.jar'));
    const disabledFiles = allFiles.filter(f => f.endsWith('.jar.disabled'));
    const disabledNames = new Set(disabledFiles.map(df => df.replace('.jar.disabled', '').toLowerCase()));

    async function fetchDependencyInfo(dep) {
        if (dep.project_id) {
            try {
                const pr = await fetch(`https://api.modrinth.com/v2/project/${dep.project_id}`);
                if (!pr.ok) return { projectName: dep.project_id, projectSlug: null };
                const pd = await pr.json();
                return { projectName: pd.title || dep.project_id, projectSlug: pd.slug || null };
            } catch (_) {
                return { projectName: dep.project_id, projectSlug: null };
            }
        }
        if (dep.version_id) {
            try {
                const vr = await fetch(`${MODRINTH_API}/version/${dep.version_id}`);
                if (!vr.ok) return { projectName: dep.version_id, projectSlug: null };
                const vd = await vr.json();
                return { projectName: vd.name || vd.version_number || dep.version_id, projectSlug: vd.project_id || null };
            } catch (_) {
                return { projectName: dep.version_id, projectSlug: null };
            }
        }
        return { projectName: 'Unbekannte Abhängigkeit', projectSlug: null };
    }

    async function searchModByDepNameCheck(depName) {
        const searchVariants = [depName];
        const cleaned = depName.replace(/-(fabric|forge|neoforge|quilt|mc\d+.*|\d+\.\d+.*)$/i, '')
                               .replace(/_(fabric|forge|neoforge|quilt|mc\d+.*|\d+\.\d+.*)$/i, '');
        if (cleaned !== depName) searchVariants.push(cleaned);

        for (const variant of searchVariants) {
            try {
                const mrRes = await fetch(`${MODRINTH_API}/search?query=${encodeURIComponent(variant)}&limit=5&facets=${encodeURIComponent(JSON.stringify([['project_type:mod']]))}`, {
                    headers: { 'User-Agent': 'SchleimyLauncher/6.0.0' }
                });
                if (mrRes.ok) {
                    const mrData = await mrRes.json();
                    if (mrData.hits && mrData.hits.length > 0) {
                        for (const hit of mrData.hits) {
                            if ((!loader || hit.categories.includes(loader)) && (!mcVersion || hit.versions.includes(mcVersion))) {
                                return { projectName: hit.title, projectSlug: hit.slug };
                            }
                        }
                        return { projectName: mrData.hits[0].title, projectSlug: mrData.hits[0].slug };
                    }
                }
            } catch (_) {}
        }
        return { projectName: depName, projectSlug: null };
    }

    // PASS 1: Inventory scan of all jars
    const parsedMods = [];
    for (const mod of mods) {
        let vData = null;
        let jarDeps = {};
        let foundModIds = [];
        const filePath = path.join(mp, mod);

        try {
            const jarInfo = parseJarForDependencies(filePath);
            if (jarInfo) {
                foundModIds = jarInfo.modIds || [];
                jarDeps = jarInfo.dependencies || {};
                for (const mid of foundModIds) {
                    if (mid) {
                        seenProjects.add(`jar:${mid.toLowerCase()}`);
                        seenProjects.add(mid.toLowerCase());
                    }
                }
            }
        } catch (_) {}

        try {
            const sha1 = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
            const res = await fetch(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
            if (res.ok) {
                vData = await res.json();
                const pid = vData.project_id;
                if (pid) {
                    if (seenProjects.has(pid) && lockFile.mods[mod]?.projectId !== pid) {
                        conflicts.push({ type: 'duplicate', message: `Doppelte Mod: ${mod}`, files: [mod] });
                    } else {
                        seenProjects.add(pid);
                        seenProjects.add(pid.toLowerCase());
                    }
                }
                if (vData.id) seenVersions.add(vData.id);
                if (!vData.game_versions?.includes(mcVersion)) {
                    conflicts.push({ type: 'version', message: `${mod} ist nicht für MC ${mcVersion} verifiziert.`, files: [mod] });
                }
                if (!vData.loaders?.includes(loader)) {
                    conflicts.push({ type: 'loader', message: `${mod} unterstützt ${loader} nicht.`, files: [mod] });
                }
            }
        } catch (_) {}

        const cleanName = mod.replace(/\.jar$/i, '').replace(/[-_v0-9+.]+$/g, '').toLowerCase();
        if (cleanName) seenProjects.add(cleanName);

        parsedMods.push({ mod, vData, jarDeps });
    }

    // PASS 2: Check dependencies against complete seenProjects
    const reportedMissing = new Set();
    for (const { mod, vData, jarDeps } of parsedMods) {
        for (const [depModId, depEntries] of Object.entries(jarDeps)) {
            if (isIgnoredDependency(depModId, loader)) continue;
            const cleanDepId = depModId.toLowerCase();
            for (const entry of depEntries) {
                if (entry.mandatory === false) continue;
                if (seenProjects.has(`jar:${cleanDepId}`) || seenProjects.has(cleanDepId)) continue;
                if (disabledNames.has(cleanDepId)) continue; // Will be activated by fix-mod-conflicts
                if (reportedMissing.has(cleanDepId)) continue;
                reportedMissing.add(cleanDepId);

                const info = await searchModByDepNameCheck(depModId);
                missing.push({ requiredBy: mod, projectId: info.projectSlug || depModId, versionId: null, projectName: info.projectName || depModId, projectSlug: info.projectSlug || depModId, fromJar: true });
            }
        }

        if (vData) {
            for (const dep of (vData.dependencies || [])) {
                if (dep.dependency_type !== 'required') continue;
                const depProject = dep.project_id;
                const depVersion = dep.version_id;
                const cleanKey = String(depProject || depVersion || '').toLowerCase();
                if (isIgnoredDependency(cleanKey, loader)) continue;
                const depInstalled = (depProject && (seenProjects.has(depProject) || seenProjects.has(depProject.toLowerCase()))) ||
                                     (depVersion && seenVersions.has(depVersion));
                if (depInstalled) continue;
                if (reportedMissing.has(depProject || depVersion)) continue;
                if (depProject) reportedMissing.add(depProject);

                const info = await fetchDependencyInfo(dep);
                missing.push({ requiredBy: mod, projectId: depProject || info.projectSlug, versionId: depVersion, projectName: info.projectName, projectSlug: info.projectSlug || depProject, fromJar: false });
            }
        }

        if (!vData && Object.keys(jarDeps).length === 0) {
            unchecked.push(mod);
        }
    }

    return { conflicts, missing, unchecked };
});

// ===== GAME LAUNCH =====
let launcherListenersReady = false;
function ensureLauncherListeners() {
    if (launcherListenersReady) return;
    launcher.on('download', (e) => sendEvent('progress', `Download: ${e}`));
    launcher.on('data', (e) => { 
        const msg = String(e); 
        sendEvent('progress', msg); 
        sendEvent('game-log', msg, { raw: msg }); 
        if (logWindow && !logWindow.isDestroyed()) logWindow.webContents.send('launcher-event', { type: 'game-log', data: { raw: msg } }); 
        
        // P2P Log Parsing
        const match = msg.match(/Local game hosted on port \[?(\d+)\]?/i) || msg.match(/Started on port \[?(\d+)\]?/i);
        if (match && match[1]) {
            const lanPort = parseInt(match[1], 10);
            const pType = pendingHostType || 'private';
            startP2PHost(lanPort, pType, pendingHostProfileData || {});
            pendingHostType = null;
        }
    });
    launcher.on('close', (code) => { 
        const pt = gameStartTime ? Math.floor((Date.now() - gameStartTime) / 1000) : 0; 
        if (currentGameProfile) recordPlaytimeForProfile(currentGameProfile, pt);
        gameProcess = null; 
        gameStartTime = null; 
        currentGameProfile = null;
        updateDiscordRPC('Im Hauptmenü', 'Durchstöbert Modpacks');
        sendEvent('game-closed', 'Minecraft beendet.', { exitCode: code, playTimeSeconds: pt }); 
        stopP2P();
    });
    launcher.on('error', (err) => {
        gameProcess = null;
        gameStartTime = null;
        sendEvent('game-closed', `Minecraft beendet (Fehler).`);
        stopP2P();
    });
    launcherListenersReady = true;
}

// ===== P2P NETWORKING LOGIC =====
function stopP2P() {
    if (hostSwarm) { hostSwarm.destroy(); hostSwarm = null; }
    if (clientSwarm) { clientSwarm.destroy(); clientSwarm = null; }
    if (localProxyServer) { localProxyServer.close(); localProxyServer = null; }
    pendingHostType = null;
    pendingHostProfileData = null;
    activeHostCode = null;
    if (mainWindow) mainWindow.webContents.send('p2p-status', { hosting: false });
}

function startP2PHost(lanPort, type, profileData) {
    if (hostSwarm) stopP2P();
    hostSwarm = new Hyperswarm();
    hostSwarm.on('error', () => {}); 
    activeHostCode = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
    const privateTopic = crypto.createHash('sha256').update(activeHostCode).digest();
    
    // Read mods and generate hashes for auto-installer
    const modsList = [];
    try {
        const mp = path.join(instancesDir, profileData.name, 'mods');
        if (fs.existsSync(mp)) {
            const files = fs.readdirSync(mp).filter(f => f.endsWith('.jar'));
            for (const f of files) {
                const sha1 = crypto.createHash('sha1').update(fs.readFileSync(path.join(mp, f))).digest('hex');
                modsList.push({ filename: f, hash: sha1 });
            }
        }
    } catch(e) {}

    hostSwarm.on('connection', (conn, info) => {
        // When a peer connects, send them server info
        const auth = loadAuthToken();
        const hostName = (auth && auth.name) ? auth.name : os.userInfo().username;
        const serverInfo = { type: 'server-info', name: `${hostName}'s Welt`, host: hostName, mods: modsList, loader: profileData?.loader, mcVersion: profileData?.version };
        conn.write(JSON.stringify(serverInfo) + '\n');
        
        // Wait for 'JOIN' command
        conn.once('data', (data) => {
            const msg = data.toString().trim();
            if (msg === 'JOIN') {
                const localSocket = net.connect(lanPort, '127.0.0.1');
                conn.pipe(localSocket).pipe(conn);
                localSocket.on('error', () => conn.destroy());
                conn.on('error', () => localSocket.destroy());
            }
        });
    });

    hostSwarm.join(privateTopic, { server: true, client: false });
    if (type === 'public') {
        hostSwarm.join(PUBLIC_SERVERS_TOPIC, { server: true, client: false });
    }
    if (mainWindow) mainWindow.webContents.send('p2p-status', { hosting: true, code: activeHostCode, type });
    sendEvent('progress', `P2P Host gestartet! Code: ${activeHostCode}`);
}

ipcMain.on('start-minecraft', async (_e, options) => {
    const auth = loadAuthToken();
    if (!auth) { sendEvent('error', 'Nicht eingeloggt! Bitte zuerst anmelden.'); return; }
    createLogWindow();
    const settings = loadSettings();
    const profiles = loadProfiles();
    const profileCfg = profiles[options.profileName] || {};
    currentGameProfile = options.profileName;
    const ramGB = profileCfg.ram || settings.ram || 4;
    const ramMB = ramGB * 1024;
    const profilePath = path.join(instancesDir, options.profileName);
    ensureLauncherListeners();
    const presetName = profileCfg.jvmPreset || settings.jvmPreset || 'default';
    const presetArgs = JVM_PRESETS[presetName] || [];
    const customArgs = profileCfg.jvmArgs ? profileCfg.jvmArgs.split(' ').filter(Boolean) : [];
    const opts = { clientPackage: null, authorization: auth, root: profilePath, version: { number: options.version, type: 'release' }, memory: { max: `${ramMB}M`, min: '1024M' }, customArgs: [...presetArgs, ...customArgs], overrides: { gameDirectory: profilePath } };
    
    // Auto-Connect if join proxy is active
    if (options.isJoin) {
        opts.server = {
            host: '127.0.0.1',
            port: '25565'
        };
    }

    const javaPath = profileCfg.javaPath || settings.javaPath;
    if (javaPath) opts.javaPath = javaPath;
    try {
        sendEvent('progress', 'Spiel wird vorbereitet...');
        if (options.loader === 'fabric') {
            sendEvent('progress', 'Fabric Loader wird konfiguriert...');
            const loadersRes = await fetch('https://meta.fabricmc.net/v2/versions/loader');
            const loaders = await loadersRes.json();
            const lv = loaders[0].version;
            const pRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${options.version}/${lv}/profile/json`);
            if (pRes.ok) { const pJson = await pRes.json(); const cv = `fabric-loader-${lv}-${options.version}`; const vd = path.join(profilePath, 'versions', cv); fs.mkdirSync(vd, { recursive: true }); fs.writeFileSync(path.join(vd, `${cv}.json`), JSON.stringify(pJson)); opts.version.custom = cv; }
        } else if (options.loader === 'forge') {
            sendEvent('progress', 'Forge wird konfiguriert...');
            const fjp = path.join(profilePath, `forge-installer-${options.version}.jar`);
            if (!fs.existsSync(fjp)) { const pr = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'); const promos = await pr.json(); let fv = promos.promos[`${options.version}-latest`] || promos.promos[`${options.version}-recommended`]; if (fv) { sendEvent('progress', `Lade Forge ${fv}...`); const r = await fetch(`https://maven.minecraftforge.net/net/minecraftforge/forge/${options.version}-${fv}/forge-${options.version}-${fv}-installer.jar`); if (r.ok) fs.writeFileSync(fjp, Buffer.from(await r.arrayBuffer())); } }
            if (fs.existsSync(fjp)) opts.forge = fjp;
        } else if (options.loader === 'quilt') {
            sendEvent('progress', 'Quilt Loader wird konfiguriert...');
            try {
                const loadersRes = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${options.version}`);
                if (loadersRes.ok) {
                    const loaders = await loadersRes.json();
                    if (loaders.length > 0) {
                        const lv = loaders[0].loader.version;
                        const pRes = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${options.version}/${lv}/profile/json`);
                        if (pRes.ok) { 
                            const pJson = await pRes.json(); 
                            const cv = `quilt-loader-${lv}-${options.version}`; 
                            const vd = path.join(profilePath, 'versions', cv); 
                            fs.mkdirSync(vd, { recursive: true }); 
                            fs.writeFileSync(path.join(vd, `${cv}.json`), JSON.stringify(pJson)); 
                            opts.version.custom = cv; 
                        }
                    }
                }
            } catch(e) { console.error(e); }
        } else if (options.loader === 'neoforge') {
            sendEvent('progress', 'NeoForge wird konfiguriert...');
            const match = options.version.match(/^1\.(\d+)(?:\.(\d+))?/);
            if (match) {
                const prefix = `${match[1]}.${match[2] || '0'}.`;
                const njp = path.join(profilePath, `neoforge-installer-${options.version}.jar`);
                if (!fs.existsSync(njp)) {
                    sendEvent('progress', 'Suche neueste NeoForge Version...');
                    try {
                        const pr = await fetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
                        if (pr.ok) {
                            const xml = await pr.text();
                            const versions = [...xml.matchAll(/<version>(.+?)<\/version>/g)].map(m => m[1]);
                            const valid = versions.filter(v => v.startsWith(prefix));
                            if (valid.length > 0) {
                                const nv = valid[valid.length - 1];
                                sendEvent('progress', `Lade NeoForge ${nv}...`);
                                const r = await fetch(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${nv}/neoforge-${nv}-installer.jar`);
                                if (r.ok) fs.writeFileSync(njp, Buffer.from(await r.arrayBuffer()));
                            }
                        }
                    } catch (e) { console.error(e); }
                }
                if (fs.existsSync(njp)) opts.forge = njp;
            }
        }
        gameStartTime = Date.now();
        updateDiscordRPC('Spielt Minecraft', `Profil: ${options.profileName}`, gameStartTime);
        
        // P2P Setup
        pendingHostProfileData = Object.assign({ name: options.profileName }, profileCfg);
        if (profileCfg.hostMode === 'public' || profileCfg.hostMode === 'private') {
            pendingHostType = profileCfg.hostMode;
            sendEvent('progress', `Warte auf LAN-Öffnung für P2P-Host (${profileCfg.hostMode})...`);
        }

        gameProcess = await launcher.launch(opts);
        sendEvent('game-started', 'Spiel gestartet!', { startTime: gameStartTime });
    } catch (error) { gameProcess = null; gameStartTime = null; currentGameProfile = null; sendEvent('error', `Startfehler: ${error.message}`); }
});

ipcMain.on('stop-minecraft', () => {
    if (gameProcess) {
        try {
            gameProcess.kill();
        } catch (e) {
            console.error('Fehler beim Beenden des Spiels:', e);
        }
    }
});

ipcMain.handle('get-stats', () => loadStats());
ipcMain.handle('choose-background-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow || null, {
        title: 'Hintergrundbild auswählen',
        properties: ['openFile'],
        filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

// Feature 7: Performance Monitor
let lastCpus = os.cpus();
ipcMain.handle('get-performance', () => {
    try {
        const cpus = os.cpus();
        let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
        for (let cpu of cpus) {
            if (cpu.times) {
                user += cpu.times.user || 0;
                nice += cpu.times.nice || 0;
                sys += cpu.times.sys || 0;
                idle += cpu.times.idle || 0;
                irq += cpu.times.irq || 0;
            }
        }
        
        let lastUser = 0, lastNice = 0, lastSys = 0, lastIdle = 0, lastIrq = 0;
        if (lastCpus && lastCpus.length > 0) {
            for (let cpu of lastCpus) {
                if (cpu.times) {
                    lastUser += cpu.times.user || 0;
                    lastNice += cpu.times.nice || 0;
                    lastSys += cpu.times.sys || 0;
                    lastIdle += cpu.times.idle || 0;
                    lastIrq += cpu.times.irq || 0;
                }
            }
        }

        const total = (user - lastUser) + (nice - lastNice) + (sys - lastSys) + (idle - lastIdle) + (irq - lastIrq);
        const active = (user - lastUser) + (nice - lastNice) + (sys - lastSys) + (irq - lastIrq);
        
        let percent = total > 0 ? (active / total) * 100 : 0;
        if (isNaN(percent) || !isFinite(percent)) percent = 0;
        
        lastCpus = cpus;

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        let ram = (totalMem - freeMem) / (1024 * 1024);
        if (isNaN(ram) || !isFinite(ram)) ram = 0;

        let pt = 0;
        if (gameStartTime && typeof gameStartTime === 'number' && !isNaN(gameStartTime)) {
            pt = Math.floor((Date.now() - gameStartTime) / 1000);
        }

        return { 
            cpu: percent, 
            ram: ram, 
            gameRunning: !!gameProcess, 
            playTime: pt 
        };
    } catch (e) {
        return { cpu: 0, ram: 0, gameRunning: !!gameProcess, playTime: 0 };
    }
});

// ===== EXTERNAL IMPORTS (SETUP WIZARD) =====
ipcMain.handle('scan-external-instances', async () => {
    const found = [];
    const userProfile = os.homedir();
    const appData = app.getPath('appData');
    
    // Check CurseForge
    const cfPath = path.join(userProfile, 'curseforge', 'minecraft', 'Instances');
    if (fs.existsSync(cfPath)) {
        try {
            const dirs = fs.readdirSync(cfPath, { withFileTypes: true }).filter(d => d.isDirectory());
            for (const d of dirs) {
                if (fs.existsSync(path.join(cfPath, d.name, 'minecraftinstance.json'))) {
                    found.push({ name: d.name, path: path.join(cfPath, d.name), source: 'CurseForge' });
                }
            }
        } catch (_) {}
    }

    // Check Modrinth
    const mrPath = path.join(appData, 'ModrinthApp', 'profiles');
    if (fs.existsSync(mrPath)) {
        try {
            const dirs = fs.readdirSync(mrPath, { withFileTypes: true }).filter(d => d.isDirectory());
            for (const d of dirs) {
                if (fs.existsSync(path.join(mrPath, d.name, 'profile.json'))) {
                    found.push({ name: d.name, path: path.join(mrPath, d.name), source: 'Modrinth' });
                }
            }
        } catch (_) {}
    }
    
    return found;
});

ipcMain.handle('import-external-instance', async (_e, { sourcePath, name, source }) => {
    try {
        const baseName = name;
        let newName = baseName, counter = 1;
        const profiles = loadProfiles();
        while (profiles[newName] || fs.existsSync(path.join(instancesDir, newName))) {
            newName = `${baseName} (${counter++})`;
        }
        
        const destPath = path.join(instancesDir, newName);
        
        // Copy directory recursively
        const copyRecursive = (src, dest) => {
            if (fs.statSync(src).isDirectory()) {
                if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                fs.readdirSync(src).forEach(item => copyRecursive(path.join(src, item), path.join(dest, item)));
            } else {
                fs.copyFileSync(src, dest);
            }
        };
        
        copyRecursive(sourcePath, destPath);
        
        // Infer version and loader
        let loader = 'forge';
        let version = '1.20.1';
        
        if (source === 'CurseForge') {
            const mi = path.join(destPath, 'minecraftinstance.json');
            if (fs.existsSync(mi)) {
                try {
                    const data = JSON.parse(fs.readFileSync(mi, 'utf8'));
                    if (data.baseModLoader) {
                        const lName = data.baseModLoader.name.toLowerCase();
                        if (lName.includes('fabric')) loader = 'fabric';
                        else if (lName.includes('neoforge')) loader = 'neoforge';
                        else if (lName.includes('quilt')) loader = 'quilt';
                    }
                    if (data.gameVersion) version = data.gameVersion;
                } catch (_) {}
            }
        } else if (source === 'Modrinth') {
            const pi = path.join(destPath, 'profile.json');
            if (fs.existsSync(pi)) {
                try {
                    const data = JSON.parse(fs.readFileSync(pi, 'utf8'));
                    if (data.metadata) {
                        if (data.metadata.gameVersion) version = data.metadata.gameVersion;
                        if (data.metadata.loader) {
                            const lName = data.metadata.loader.toLowerCase();
                            if (lName.includes('fabric')) loader = 'fabric';
                            else if (lName.includes('neoforge')) loader = 'neoforge';
                            else if (lName.includes('quilt')) loader = 'quilt';
                            else if (lName.includes('forge')) loader = 'forge';
                        }
                    }
                } catch (_) {}
            }
        }
        
        profiles[newName] = { loader, version, ram: null, javaPath: '', jvmArgs: '', jvmPreset: 'default' };
        saveProfiles(profiles);
        return { success: true, newName };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ===== SETTINGS IPC =====
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, s) => { saveSettingsFile(s); setupDiscordRPC(); return true; });
ipcMain.handle('get-system-memory', () => Math.floor(os.totalmem() / 1024 / 1024 / 1024));

// Feature 15: Server Status
ipcMain.handle('get-servers', () => loadServers());
ipcMain.handle('save-servers', (_e, s) => { saveServers(s); return true; });
ipcMain.handle('ping-server', async (_e, { host, port }) => {
    const net = require('net');
    return new Promise(resolve => {
        const start = Date.now(); const sock = new net.Socket(); sock.setTimeout(3000);
        sock.connect(port || 25565, host, () => { sock.destroy(); resolve({ online: true, ping: Date.now() - start }); });
        sock.on('error', () => { sock.destroy(); resolve({ online: false, ping: -1 }); });
        sock.on('timeout', () => { sock.destroy(); resolve({ online: false, ping: -1 }); });
    });
});

// Feature 11: Screenshots
ipcMain.handle('get-screenshots', (_e, pn) => {
    const dir = path.join(instancesDir, pn, 'screenshots');
    if (!fs.existsSync(dir)) return [];
    try { return fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).map(f => ({ filename: f, path: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size, date: fs.statSync(path.join(dir, f)).mtime.toISOString() })).sort((a,b) => new Date(b.date) - new Date(a.date)); } catch (_) { return []; }
});
ipcMain.handle('get-screenshot-data', (_e, fp) => { try { if (fs.existsSync(fp)) return `data:image/png;base64,${fs.readFileSync(fp).toString('base64')}`; } catch (_) {} return null; });
ipcMain.handle('copy-screenshot', async (_e, fp) => { try { const { clipboard, nativeImage: NI } = require('electron'); clipboard.writeImage(NI.createFromPath(fp)); return { success: true }; } catch (e) { return { success: false, error: e.message }; } });
ipcMain.handle('delete-screenshot', async (_e, filePath) => {
    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            return { success: true };
        }
        return { success: false, error: 'Datei nicht gefunden.' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('open-screenshot-folder', (_e, filePath) => {
    if (fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    return { success: true };
});

// Feature 12: Desktop Shortcut
ipcMain.handle('create-shortcut', async (_e, { profileName, version, loader }) => {
    if (process.platform !== 'win32') return { success: false, error: 'Nur unter Windows verfügbar.' };
    try {
        const dp = path.join(app.getPath('desktop'), `${profileName}.lnk`);
        const vbs = `Set WshShell = CreateObject("WScript.Shell")\nSet oLink = WshShell.CreateShortcut("${dp.replace(/\\/g,'\\\\')}")\noLink.TargetPath = "${process.execPath.replace(/\\/g,'\\\\')}"\noLink.Arguments = "--launch ""${profileName}"" --version ""${version}"" --loader ""${loader}"""\noLink.Description = "Schleimy Launcher - ${profileName}"\noLink.WorkingDirectory = "${__dirname.replace(/\\/g,'\\\\')}"\noLink.Save`;
        const vbsPath = path.join(baseDir, 'shortcut.vbs');
        fs.writeFileSync(vbsPath, vbs);
        exec(`cscript //nologo "${vbsPath}"`, () => { try { fs.unlinkSync(vbsPath); } catch (_) {} });
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// Feature 17: Crash Log Analyzer
ipcMain.handle('analyze-crash', async (_e, profileName) => {
    const cd = path.join(instancesDir, profileName, 'crash-reports');
    if (!fs.existsSync(cd)) return { found: false, message: 'Keine Crash-Reports gefunden.' };
    try {
        const reports = fs.readdirSync(cd).filter(f => f.endsWith('.txt')).sort().reverse();
        if (reports.length === 0) return { found: false, message: 'Keine Crash-Reports gefunden.' };
        const content = fs.readFileSync(path.join(cd, reports[0]), 'utf8');
        return { found: true, filename: reports[0], ...analyzeCrash(content), rawContent: content.substring(0, 5000) };
    } catch (e) { return { found: false, message: e.message }; }
});
function analyzeCrash(content) {
    const lines = content.split('\n');
    let cause = 'Unbekannter Fehler', solution = '', involvedMods = [];
    const descLine = lines.find(l => l.includes('Description:'));
    if (descLine) cause = descLine.replace('Description:', '').trim();
    const exLine = lines.find(l => l.includes('Exception') || l.includes('Error'));
    if (exLine) {
        if (exLine.includes('OutOfMemoryError')) { cause = 'Nicht genug RAM'; solution = 'Erhöhe den RAM in den Profil-Einstellungen.'; }
        else if (exLine.includes('NoClassDefFoundError')) { cause = 'Fehlende Mod-Abhängigkeit'; solution = 'Prüfe ob alle Dependencies (z.B. Fabric API) installiert sind.'; }
        else if (exLine.includes('mixin') || exLine.includes('Mixin')) { cause = 'Mixin-Konflikt zwischen Mods'; solution = 'Zwei Mods verändern denselben Code. Entferne nacheinander Mods.'; }
    }
    const modSet = new Set();
    for (const line of lines) { for (const m of line.matchAll(/at\s+([a-z]+\.[a-z]+)/gi)) { const p = m[1].toLowerCase(); if (!p.startsWith('net.minecraft') && !p.startsWith('java.') && !p.startsWith('com.mojang') && !p.startsWith('org.lwjgl')) modSet.add(p); } }
    involvedMods = [...modSet].slice(0, 10);
    return { cause, solution, involvedMods };
}

// Feature 18: Game Logs
ipcMain.handle('get-game-log', (_e, pn) => { const lp = path.join(instancesDir, pn, 'logs', 'latest.log'); try { if (fs.existsSync(lp)) { const c = fs.readFileSync(lp, 'utf8'); return c.substring(c.length - 50000); } } catch (_) {} return ''; });

// Feature 20: Portable Mode
ipcMain.handle('get-portable-status', () => ({ isPortable, dataPath: baseDir }));
ipcMain.handle('enable-portable', () => { try { fs.writeFileSync(path.join(__dirname, '.portable'), 'true'); return { success: true, message: 'Portabler Modus aktiviert. Neustart erforderlich.' }; } catch (e) { return { success: false, error: e.message }; } });

// Feature 5: Java Info
ipcMain.handle('get-java-info', async () => {
    return new Promise(resolve => {
        exec('java -version 2>&1', (err, stdout, stderr) => {
            const output = stderr || stdout || '';
            const match = output.match(/version "([^"]+)"/);
            resolve([{ type: 'system', version: match ? match[1] : 'Nicht gefunden', path: 'java', available: !err }]);
        });
    });
});
// ===== FEATURE 1: FPS Booster =====
ipcMain.handle('get-fps-booster-mods', async (_e, { loader, mcVersion }) => {
    let mods = [];
    if (loader === 'fabric' || loader === 'quilt') {
        mods = ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'modernfix', 'starlight', 'krypton', 'lazydfu', 'iris'];
    } else if (loader === 'forge' || loader === 'neoforge') {
        mods = ['embeddium', 'modernfix', 'ferrite-core', 'entityculling', 'starlight', 'oculus'];
    }
    const results = [];
    for (const slug of mods) {
        try {
            const data = await searchModrinth(slug, { type: 'mod', loader, version: mcVersion }, 1, 0);
            if (data.hits && data.hits.length > 0) {
                const hit = data.hits[0];
                results.push({ slug: hit.slug || slug, name: hit.title, description: hit.description, source: 'modrinth' });
            }
        } catch (e) {}
    }
    return results;
});

async function installModListWithDeps(profileName, loader, mcVersion, slugList, label = 'Modpack Assistent') {
    sendEvent('info', `Starte ${label}: Installiere ${slugList.length} Mods für ${loader} ${mcVersion}...`);
    let installed = 0;
    const downloadedIds = new Set();
    for (const slug of slugList) {
        try {
            sendEvent('info', `${label}: Installiere ${slug}...`);
            const versionData = await getModrinthModVersion(slug, loader, mcVersion);
            if (versionData && versionData.url) {
                const pid = versionData.projectId || slug;
                if (!downloadedIds.has(pid)) {
                    await downloadModFile({ downloadUrl: versionData.url, fileName: versionData.filename, profileName, projectId: pid, source: 'modrinth', versionId: versionData.versionId, versionNumber: versionData.versionNumber });
                    downloadedIds.add(pid);
                    installed++;
                    await new Promise(r => setTimeout(r, 30));
                }
                if (versionData.dependencies && versionData.dependencies.length > 0) {
                    for (const dep of versionData.dependencies) {
                        if (dep.dependency_type === 'required' && dep.project_id && !downloadedIds.has(dep.project_id)) {
                            try {
                                const depVersion = await getModrinthModVersion(dep.project_id, loader, mcVersion);
                                if (depVersion && depVersion.url) {
                                    await downloadModFile({ downloadUrl: depVersion.url, fileName: depVersion.filename, profileName, projectId: dep.project_id, source: 'modrinth', versionId: depVersion.versionId, versionNumber: depVersion.versionNumber });
                                    downloadedIds.add(dep.project_id);
                                    installed++;
                                    await new Promise(r => setTimeout(r, 30));
                                }
                            } catch (err) {}
                        }
                    }
                }
            }
        } catch(e) { console.warn(`${label}: Failed to install ${slug}:`, e.message); }
    }
    sendEvent('success', `${label}: ${installed} Mods erfolgreich installiert!`);
    return { success: true, count: installed };
}

ipcMain.handle('install-fps-booster', async (_e, { profileName, loader, mcVersion, slugList }) => {
    return installModListWithDeps(profileName, loader, mcVersion, slugList, 'Mod-Installation');
});

ipcMain.handle('install-wizard-mods', async (_e, { profileName, loader, mcVersion, slugList }) => {
    return installModListWithDeps(profileName, loader, mcVersion, slugList, 'Modpack Assistent');
});

// ===== FEATURE 2: World & Save Manager =====
ipcMain.handle('get-worlds', async (_e, profileName) => {
    const savesDir = path.join(instancesDir, profileName, 'saves');
    if (!fs.existsSync(savesDir)) return [];
    try {
        const worlds = [];
        const dirs = fs.readdirSync(savesDir, { withFileTypes: true });
        for (const dir of dirs) {
            if (dir.isDirectory()) {
                const worldPath = path.join(savesDir, dir.name);
                const levelDat = path.join(worldPath, 'level.dat');
                let lastPlayed = fs.statSync(worldPath).mtime;
                if (fs.existsSync(levelDat)) {
                    lastPlayed = fs.statSync(levelDat).mtime;
                }
                const size = fs.existsSync(worldPath) ? fs.readdirSync(worldPath, { recursive: true }).reduce((acc, f) => {
                    const p = path.join(worldPath, f);
                    try { const s = fs.statSync(p); return acc + (s.isFile() ? s.size : 0); } catch(_) { return acc; }
                }, 0) : 0;
                worlds.push({ name: dir.name, folderName: dir.name, size, lastPlayed: lastPlayed.toISOString(), gameMode: 'Unknown', seed: 'Unknown' });
            }
        }
        return worlds.sort((a,b) => new Date(b.lastPlayed) - new Date(a.lastPlayed));
    } catch(e) { return []; }
});

ipcMain.handle('backup-world', async (_e, { profileName, worldName }) => {
    try {
        const savesDir = path.join(instancesDir, profileName, 'saves');
        const worldPath = path.join(savesDir, worldName);
        const backupsDir = path.join(instancesDir, profileName, 'backups');
        if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
        if (!fs.existsSync(worldPath)) return { success: false, error: 'World not found' };
        const backupPath = path.join(backupsDir, `${worldName}_${Date.now()}.zip`);
        const zip = new AdmZip();
        zip.addLocalFolder(worldPath);
        zip.writeZip(backupPath);
        return { success: true, backupPath };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('restore-world-backup', async (_e, { profileName, backupPath }) => {
    try {
        if (!fs.existsSync(backupPath)) return { success: false, error: 'Backup not found' };
        const zip = new AdmZip(backupPath);
        const worldName = path.basename(backupPath).replace(/_\d+\.zip$/, '');
        const worldPath = path.join(instancesDir, profileName, 'saves', worldName);
        if (fs.existsSync(worldPath)) fs.rmSync(worldPath, { recursive: true, force: true });
        zip.extractAllTo(worldPath, true);
        return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('get-world-backups', async (_e, profileName) => {
    const backupsDir = path.join(instancesDir, profileName, 'backups');
    if (!fs.existsSync(backupsDir)) return [];
    try {
        return fs.readdirSync(backupsDir)
            .filter(f => f.endsWith('.zip'))
            .map(f => {
                const fp = path.join(backupsDir, f);
                const stat = fs.statSync(fp);
                return { filename: f, path: fp, size: stat.size, date: stat.mtime.toISOString() };
            });
    } catch(e) { return []; }
});

ipcMain.handle('delete-world', async (_e, { profileName, worldName }) => {
    try {
        const worldPath = path.join(instancesDir, profileName, 'saves', worldName);
        if (fs.existsSync(worldPath)) fs.rmSync(worldPath, { recursive: true, force: true });
        return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('duplicate-world', async (_e, { profileName, worldName }) => {
    try {
        const src = path.join(instancesDir, profileName, 'saves', worldName);
        const dest = path.join(instancesDir, profileName, 'saves', `${worldName}_copy`);
        if (fs.existsSync(src)) {
            fs.cpSync(src, dest, { recursive: true });
            return { success: true };
        }
        return { success: false, error: 'World not found' };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('auto-backup-before-launch', async (_e, profileName) => {
    try {
        const savesDir = path.join(instancesDir, profileName, 'saves');
        const backupsDir = path.join(instancesDir, profileName, 'backups');
        if (!fs.existsSync(savesDir)) return { success: true };
        if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
        
        const dirs = fs.readdirSync(savesDir, { withFileTypes: true });
        for (const dir of dirs) {
            if (dir.isDirectory()) {
                const worldName = dir.name;
                const worldPath = path.join(savesDir, worldName);
                const backupPath = path.join(backupsDir, `${worldName}_auto_${Date.now()}.zip`);
                const zip = new AdmZip();
                zip.addLocalFolder(worldPath);
                zip.writeZip(backupPath);
                
                const worldBackups = fs.readdirSync(backupsDir)
                    .filter(f => f.startsWith(`${worldName}_auto_`) && f.endsWith('.zip'))
                    .map(f => ({ name: f, time: fs.statSync(path.join(backupsDir, f)).mtime.getTime() }))
                    .sort((a, b) => b.time - a.time);
                    
                if (worldBackups.length > 3) {
                    for (let i = 3; i < worldBackups.length; i++) {
                        fs.unlinkSync(path.join(backupsDir, worldBackups[i].name));
                    }
                }
            }
        }
        return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
});

// ===== FEATURE 3: Config Editor =====
ipcMain.handle('get-config-files', async (_e, profileName) => {
    const configDir = path.join(instancesDir, profileName, 'config');
    const optionsPath = path.join(instancesDir, profileName, 'options.txt');
    const files = [];
    if (fs.existsSync(optionsPath)) {
        files.push({ filename: 'options.txt', path: optionsPath, size: fs.statSync(optionsPath).size, type: 'txt' });
    }
    if (fs.existsSync(configDir)) {
        const readDirRec = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fp = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    readDirRec(fp);
                } else if (/\.(toml|json|cfg|properties|yml|yaml)$/i.test(entry.name)) {
                    files.push({ filename: path.relative(path.join(instancesDir, profileName), fp), path: fp, size: fs.statSync(fp).size, type: path.extname(entry.name).substring(1) });
                }
            }
        };
        readDirRec(configDir);
    }
    return files;
});

ipcMain.handle('read-config-file', async (_e, filePath) => {
    try {
        if (!fs.existsSync(filePath)) return '';
        const stat = fs.statSync(filePath);
        if (stat.size > 500 * 1024) return 'File too large (>500KB)';
        return fs.readFileSync(filePath, 'utf8');
    } catch(e) { return `Error: ${e.message}`; }
});

ipcMain.handle('save-config-file', async (_e, { filePath, content }) => {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
        return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('read-options-txt', async (_e, profileName) => {
    const optionsPath = path.join(instancesDir, profileName, 'options.txt');
    if (!fs.existsSync(optionsPath)) return {};
    try {
        const content = fs.readFileSync(optionsPath, 'utf8');
        const options = {};
        for (const line of content.split('\n')) {
            const sep = line.indexOf(':');
            if (sep !== -1) {
                const k = line.substring(0, sep).trim();
                const v = line.substring(sep + 1).trim();
                options[k] = v;
            }
        }
        return options;
    } catch(e) { return {}; }
});

ipcMain.handle('save-options-txt', async (_e, { profileName, optionsObj }) => {
    const optionsPath = path.join(instancesDir, profileName, 'options.txt');
    try {
        const lines = [];
        for (const [k, v] of Object.entries(optionsObj)) {
            lines.push(`${k}:${v}`);
        }
        fs.writeFileSync(optionsPath, lines.join('\n'), 'utf8');
        return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
});

// ===== FEATURE 4: Server-Sync =====
ipcMain.handle('create-sync-link', async (_e, profileName) => {
    try {
        const profiles = loadProfiles();
        const p = profiles[profileName];
        if (!p) throw new Error('Profile not found');
        const lockPath = path.join(instancesDir, profileName, 'schleimy-lock.json');
        let mods = [];
        if (fs.existsSync(lockPath)) {
            const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            mods = Object.values(lock.mods || {}).map(m => ({ slug: m.projectId, source: m.source, versionId: m.versionId, filename: m.fileName }));
        }
        const manifest = { loader: p.loader, version: p.version, mods };
        return { syncCode: Buffer.from(JSON.stringify(manifest)).toString('base64') };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('apply-sync-link', async (_e, { syncCode, targetProfileName }) => {
    try {
        const manifest = JSON.parse(Buffer.from(syncCode, 'base64').toString('utf8'));
        const lockPath = path.join(instancesDir, targetProfileName, 'schleimy-lock.json');
        let currentMods = {};
        if (fs.existsSync(lockPath)) {
            const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            currentMods = lock.mods || {};
        }
        const currentFilenames = new Set(Object.values(currentMods).map(m => m.fileName));
        const manifestFilenames = new Set(manifest.mods.map(m => m.filename));
        
        let added = 0, removed = 0;
        const targetModsDir = path.join(instancesDir, targetProfileName, 'mods');
        if (!fs.existsSync(targetModsDir)) fs.mkdirSync(targetModsDir, { recursive: true });
        
        for (const fn of currentFilenames) {
            if (!manifestFilenames.has(fn)) {
                const fp = path.join(targetModsDir, fn);
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
                removed++;
            }
        }
        
        for (const m of manifest.mods) {
            if (!currentFilenames.has(m.filename)) {
                if (m.source === 'modrinth') {
                    try {
                        const res = await fetch(`${MODRINTH_API}/version/${m.versionId}`);
                        if (res.ok) {
                            const data = await res.json();
                            const f = data.files[0];
                            await downloadModFile({ downloadUrl: f.url, fileName: f.filename, profileName: targetProfileName, projectId: m.slug, source: m.source, versionId: m.versionId, versionNumber: data.version_number });
                            added++;
                        }
                    } catch(ex) {}
                }
            }
        }
        return { success: true, added, removed };
    } catch(e) { return { success: false, error: e.message }; }
});

// ===== FEATURE 5: Modpack Creator Wizard =====
ipcMain.handle('get-modpack-suggestions', async (_e, { category, loader, mcVersion, maxRam }) => {
    try {
        const catMap = {
            'performance': ['optimization'],
            'rpg': ['magic', 'adventure'],
            'tech': ['technology', 'storage'],
            'adventure': ['adventure', 'worldgen'],
            'kitchensink': ['technology', 'magic', 'adventure', 'optimization', 'storage'],
            'minimal': ['utility', 'qol']
        };
        const mappedCats = catMap[category] || [];
        let hits = [];
        if (mappedCats.length > 0) {
            const res = await searchModrinth('', { type: 'mod', loader, version: mcVersion, category: mappedCats }, 35, 0);
            hits = res.hits || [];
        }
        if (hits.length < 4) {
            const fallbackRes = await searchModrinth('', { type: 'mod', loader, version: mcVersion, category: ['optimization', 'qol'] }, 20, 0);
            const existingSlugs = new Set(hits.map(h => h.slug));
            for (const h of (fallbackRes.hits || [])) {
                if (!existingSlugs.has(h.slug)) {
                    hits.push(h);
                    existingSlugs.add(h.slug);
                    if (hits.length >= 15) break;
                }
            }
        }
        return hits.map(h => ({
            slug: h.slug,
            name: h.title,
            description: h.description,
            downloads: h.downloads,
            iconUrl: h.icon_url
        }));
    } catch(e) { return []; }
});

// ===== FEATURE 6: AI Mod-Doctor =====
ipcMain.handle('auto-repair-mods', async (_e, { profileName, loader, mcVersion, issues }) => {
    try {
        const actions = [];
        for (const issue of (issues || [])) {
            if (issue.type === 'missing_dependency' && issue.depId) {
                try {
                    const versionData = await getModrinthModVersion(issue.depId, loader, mcVersion);
                    if (versionData && versionData.url) {
                        await downloadModFile({ downloadUrl: versionData.url, fileName: versionData.filename, profileName, projectId: issue.depId, source: 'modrinth', versionId: versionData.versionId, versionNumber: versionData.versionNumber });
                        actions.push({ type: 'download', mod: versionData.filename, detail: 'Fehlende Abhängigkeit heruntergeladen' });
                    }
                } catch(ex) { actions.push({ type: 'error', mod: issue.depId, detail: 'Konnte Abhängigkeit nicht laden: ' + ex.message }); }
            } else if (issue.type === 'incompatible' || issue.type === 'duplicate') {
                const fp = path.join(instancesDir, profileName, 'mods', issue.filename);
                if (fs.existsSync(fp)) {
                    fs.unlinkSync(fp);
                    actions.push({ type: 'delete', mod: issue.filename, detail: issue.type === 'incompatible' ? 'Inkompatibler Mod entfernt' : 'Doppelter Mod entfernt' });
                }
            }
        }
        return { success: true, actions };
    } catch(e) { return { success: false, error: e.message }; }
});

// ===== FEATURE 7: GC Analysis =====
ipcMain.handle('get-gc-analysis', async (_e, profileName) => {
    try {
        const logPath = path.join(instancesDir, profileName, 'logs', 'latest.log');
        if (!fs.existsSync(logPath)) return { gcPauses: [], memoryWarnings: [], lagSpikes: 0, recommendation: 'No log found' };
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        const gcPauses = [];
        const memoryWarnings = [];
        let lagSpikes = 0;
        
        for (const line of lines) {
            if (line.includes('Server is running') && line.includes('behind')) lagSpikes++;
            if (line.includes('OutOfMemory') || line.includes('memory usage')) memoryWarnings.push(line);
            const gcMatch = line.match(/Pause (Young|Init Mark|Remark|Cleanup) \((.*?)\) (\d+\.\d+)ms/);
            if (gcMatch) gcPauses.push({ timestamp: line.substring(0, 10), duration: parseFloat(gcMatch[3]) });
        }
        let recommendation = 'Looks good!';
        if (lagSpikes > 5) recommendation = 'Consider adding performance mods or increasing RAM.';
        if (memoryWarnings.length > 0) recommendation = 'You are running out of memory! Increase RAM allocation.';
        return { gcPauses, memoryWarnings, lagSpikes, recommendation };
    } catch(e) { return { gcPauses: [], memoryWarnings: [], lagSpikes: 0, recommendation: 'Error analyzing' }; }
});

// ===== FEATURE 8: Video & Sound =====
ipcMain.handle('choose-video-background', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Videos', extensions: ['mp4', 'webm'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});
ipcMain.handle('get-sound-effects-enabled', async () => {
    const settings = loadSettings();
    return settings.soundEffects !== false;
});
ipcMain.handle('save-sound-effects-enabled', async (_e, enabled) => {
    saveSettingsFile({ soundEffects: enabled });
    return { success: true };
});

// ===== FEATURE 10: Controller Mod =====
ipcMain.handle('install-controller-mod', async (_e, { profileName, loader, mcVersion }) => {
    try {
        const slug = (loader === 'fabric' || loader === 'quilt') ? 'midnightcontrols' : 'controllable';
        const versionData = await getModrinthModVersion(slug, loader, mcVersion);
        if (versionData && versionData.url) {
            await downloadModFile({ downloadUrl: versionData.url, fileName: versionData.filename, profileName, projectId: slug, source: 'modrinth', versionId: versionData.versionId, versionNumber: versionData.versionNumber });
            return { success: true, modName: slug };
        }
        return { success: false, error: `Kein kompatibles Release für ${slug} gefunden.` };
    } catch(e) { return { success: false, error: e.message }; }
});
