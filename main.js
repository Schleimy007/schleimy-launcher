const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const os = require('os');
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
const { autoUpdater } = require('electron-updater');const launcher = new Client();
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
function loadProfiles() { return loadJSON(profilesPath, {}); }
function saveProfiles(profiles) { saveJSON(profilesPath, profiles); }
function loadSettings() {
    const defaults = { setupCompleted: false, ram: 4, javaPath: '', showSnapshots: false, theme: 'jade', accentColor: '#00AF5C', jvmPreset: 'default', discordRPC: true, parallelDownloads: 4 };
    return { ...defaults, ...loadJSON(settingsPath, {}) };
}
function saveSettingsFile(settings) { saveJSON(settingsPath, settings); }
function loadAccounts() { return loadJSON(accountsPath, []); }
function saveAccounts(accounts) { saveJSON(accountsPath, accounts); }
function loadServers() { return loadJSON(serversPath, []); }
function saveServers(servers) { saveJSON(serversPath, servers); }

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
const DISCORD_CLIENT_ID = '1531078543596060822'; // Dummy ID, replace if you have one
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
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1380, height: 900, minWidth: 940, minHeight: 620,
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
        autoHideMenuBar: true, backgroundColor: '#111111', show: false,
        frame: false,
        icon: path.join(__dirname, 'build', 'logo.png')
    });
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => mainWindow.show());
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
    
    // Auto Updater Setup
    autoUpdater.checkForUpdatesAndNotify();
    
    autoUpdater.on('update-available', () => {
        if (mainWindow) mainWindow.webContents.send('launcher-event', { type: 'update-start' });
    });
    autoUpdater.on('download-progress', (progressObj) => {
        if (mainWindow) mainWindow.webContents.send('launcher-event', { type: 'update-progress', data: { percent: progressObj.percent } });
    });
    autoUpdater.on('update-downloaded', () => {
        if (mainWindow) mainWindow.webContents.send('launcher-event', { type: 'update-ready' });
        setTimeout(() => autoUpdater.quitAndInstall(), 3000);
    });
    autoUpdater.on('error', (err) => {
        console.error('Updater Error:', err);
    });
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
ipcMain.handle('window-close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); return true; });

// ===== AUTH IPC =====
ipcMain.handle('login-microsoft', async () => {
    try {
        const authManager = new Auth('select_account');
        const xboxManager = await authManager.launch('raw');
        const token = await xboxManager.getMinecraft();
        const mclcToken = token.mclc();
        saveAuthToken(mclcToken);
        // Feature 16: Multi-Account
        const accounts = loadAccounts();
        const existing = accounts.findIndex(a => a.uuid === mclcToken.uuid);
        const entry = { name: mclcToken.name, uuid: mclcToken.uuid, active: true };
        if (existing >= 0) accounts[existing] = { ...accounts[existing], ...entry };
        else accounts.push(entry);
        accounts.forEach(a => { a.active = (a.uuid === mclcToken.uuid); });
        saveAccounts(accounts);
        return { success: true, name: mclcToken.name, uuid: mclcToken.uuid };
    } catch (error) { return { success: false, error: String(error) }; }
});
ipcMain.handle('get-auth', () => { const t = loadAuthToken(); return t ? { name: t.name, uuid: t.uuid } : null; });
ipcMain.handle('clear-auth', () => { clearAuthToken(); return true; });
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
ipcMain.handle('create-profile', (_e, { name, loader, version }) => {
    const pp = path.join(instancesDir, name);
    if (fs.existsSync(pp)) return { success: false, error: 'Profil existiert bereits' };
    fs.mkdirSync(pp, { recursive: true });
    ['mods','shaderpacks','resourcepacks'].forEach(d => fs.mkdirSync(path.join(pp, d), { recursive: true }));
    const profiles = loadProfiles();
    profiles[name] = { loader, version, ram: null, javaPath: '', jvmArgs: '', jvmPreset: 'default' };
    saveProfiles(profiles);
    return { success: true };
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
        if (profiles[name]) zip.addFile('schleimy-metadata.json', Buffer.from(JSON.stringify({ ...profiles[name], exportedAt: new Date().toISOString(), launcherVersion: '2.0.0' })));
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
    try { return fs.readdirSync(mp).filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled')).map(f => { const s = fs.statSync(path.join(mp, f)); return { filename: f, displayName: f.replace('.jar.disabled','').replace('.jar',''), enabled: !f.endsWith('.disabled'), size: s.size, modified: s.mtime.toISOString() }; }); } catch (_) { return []; }
});
ipcMain.handle('toggle-mod', (_e, { profileName, filename }) => { return toggleFile(path.join(instancesDir, profileName, 'mods'), filename); });
ipcMain.handle('delete-mod', (_e, { profileName, filename }) => { return deleteFile(path.join(instancesDir, profileName, 'mods'), filename); });

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

// Download handler for mods/shaders/resourcepacks
ipcMain.on('download-mod', async (_e, data) => {
    const { downloadUrl, profileName, fileName, targetDir } = data;
    const subDir = targetDir || 'mods';
    const tp = path.join(instancesDir, profileName, subDir);
    if (!fs.existsSync(tp)) fs.mkdirSync(tp, { recursive: true });
    const filePath = path.join(tp, fileName);
    try {
        sendEvent('download-progress', `${fileName} wird heruntergeladen...`, { fileName, progress: 0 });
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const total = parseInt(response.headers.get('content-length') || '0');
        if (response.body && typeof response.body.getReader === 'function' && total > 0) {
            const reader = response.body.getReader(); const chunks = []; let received = 0;
            while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); received += value.length; sendEvent('download-progress', `${fileName}`, { fileName, progress: Math.round((received/total)*100), received, total }); }
            fs.writeFileSync(filePath, Buffer.concat(chunks));
        } else { fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer())); }
        sendEvent('success', `${fileName} erfolgreich installiert!`, { fileName });
    } catch (error) { sendEvent('error', `Download fehlgeschlagen: ${error.message}`, { fileName }); }
});

// Feature 2: Check for mod updates
ipcMain.handle('check-mod-updates', async (_e, { profileName, loader, mcVersion }) => {
    const mp = path.join(instancesDir, profileName, 'mods');
    if (!fs.existsSync(mp)) return [];
    const mods = fs.readdirSync(mp).filter(f => f.endsWith('.jar'));
    const updates = [];
    const crypto = require('crypto');
    for (const mod of mods) {
        try {
            const sha1 = crypto.createHash('sha1').update(fs.readFileSync(path.join(mp, mod))).digest('hex');
            const res = await fetch(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
            if (!res.ok) continue;
            const vData = await res.json();
            const vRes = await fetch(`https://api.modrinth.com/v2/project/${vData.project_id}/version?loaders=${JSON.stringify([loader])}&game_versions=${JSON.stringify([mcVersion])}`);
            if (!vRes.ok) continue;
            const versions = await vRes.json();
            if (versions.length > 0 && versions[0].id !== vData.id) {
                const lf = versions[0].files.find(f => f.primary) || versions[0].files[0];
                updates.push({ currentFile: mod, projectId: vData.project_id, projectName: vData.name || mod.replace('.jar',''), currentVersion: vData.version_number, latestVersion: versions[0].version_number, downloadUrl: lf.url, newFilename: lf.filename });
            }
        } catch (_) {}
    }
    return updates;
});
ipcMain.handle('update-mod', async (_e, { profileName, currentFile, downloadUrl, newFilename }) => {
    const mp = path.join(instancesDir, profileName, 'mods');
    try { 
        if (!fs.existsSync(mp)) fs.mkdirSync(mp, { recursive: true });
        const res = await fetch(downloadUrl); if (!res.ok) throw new Error(`HTTP ${res.status}`); fs.writeFileSync(path.join(mp, newFilename), Buffer.from(await res.arrayBuffer())); const old = path.join(mp, currentFile); if (fs.existsSync(old) && currentFile !== newFilename) fs.unlinkSync(old); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
});

// Feature 3: Mod Conflict Checker
ipcMain.handle('check-mod-conflicts', async (_e, { profileName, loader, mcVersion }) => {
    const mp = path.join(instancesDir, profileName, 'mods');
    if (!fs.existsSync(mp)) return { conflicts: [], missing: [] };
    const mods = fs.readdirSync(mp).filter(f => f.endsWith('.jar'));
    const conflicts = [], missing = [], seenProjects = new Map();
    const crypto = require('crypto');
    for (const mod of mods) {
        try {
            const sha1 = crypto.createHash('sha1').update(fs.readFileSync(path.join(mp, mod))).digest('hex');
            const res = await fetch(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
            if (!res.ok) continue;
            const vData = await res.json();
            if (seenProjects.has(vData.project_id)) conflicts.push({ type: 'duplicate', message: `Doppelte Mod: ${mod} und ${seenProjects.get(vData.project_id)}`, files: [mod, seenProjects.get(vData.project_id)] });
            else seenProjects.set(vData.project_id, mod);
            if (!vData.game_versions.includes(mcVersion)) conflicts.push({ type: 'version', message: `${mod} ist nicht für MC ${mcVersion} verifiziert.`, files: [mod] });
            if (!vData.loaders.includes(loader)) conflicts.push({ type: 'loader', message: `${mod} unterstützt ${loader} nicht.`, files: [mod] });
            for (const dep of (vData.dependencies || [])) { if (dep.dependency_type === 'required' && dep.project_id && !seenProjects.has(dep.project_id)) { try { const pr = await fetch(`https://api.modrinth.com/v2/project/${dep.project_id}`); if (pr.ok) { const pd = await pr.json(); missing.push({ requiredBy: mod, projectId: dep.project_id, projectName: pd.title, projectSlug: pd.slug }); } } catch (_) {} } }
        } catch (_) {}
    }
    return { conflicts, missing };
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
        gameProcess = null; 
        gameStartTime = null; 
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
    } catch (error) { gameProcess = null; gameStartTime = null; sendEvent('error', `Startfehler: ${error.message}`); }
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

// Feature 7: Performance Monitor
let lastCpus = os.cpus();
ipcMain.handle('get-performance', () => {
    const cpus = os.cpus();
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
    for(let cpu of cpus){ user += cpu.times.user; nice += cpu.times.nice; sys += cpu.times.sys; idle += cpu.times.idle; irq += cpu.times.irq; }
    let lastUser = 0, lastNice = 0, lastSys = 0, lastIdle = 0, lastIrq = 0;
    for(let cpu of lastCpus){ lastUser += cpu.times.user; lastNice += cpu.times.nice; lastSys += cpu.times.sys; lastIdle += cpu.times.idle; lastIrq += cpu.times.irq; }
    const total = (user - lastUser) + (nice - lastNice) + (sys - lastSys) + (idle - lastIdle) + (irq - lastIrq);
    const active = (user - lastUser) + (nice - lastNice) + (sys - lastSys) + (irq - lastIrq);
    const percent = total > 0 ? (active / total) * 100 : 0;
    lastCpus = cpus;
    return { cpu: percent, ram: (os.totalmem() - os.freemem()) / (1024 * 1024), gameRunning: !!gameProcess, playTime: gameStartTime ? Math.floor((Date.now() - gameStartTime) / 1000) : 0 };
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