const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // API (proxied through main)
    searchAll: (args) => ipcRenderer.invoke('api:searchAll', args),
    getModDetails: (args) => ipcRenderer.invoke('api:getModDetails', args),
    getModVersions: (args) => ipcRenderer.invoke('api:getModVersions', args),
    getModVersion: (args) => ipcRenderer.invoke('api:getModVersion', args),
    resolveAllDependencies: (args) => ipcRenderer.invoke('api:resolveAllDependencies', args),

    // Window Controls
    windowMinimize: () => ipcRenderer.invoke('window-minimize'),
    windowMaximize: () => ipcRenderer.invoke('window-maximize'),
    windowClose: (shift) => ipcRenderer.invoke('window-close', shift),

    // Auth
    loginMicrosoft: () => ipcRenderer.invoke('login-microsoft'),
    getAuth: () => ipcRenderer.invoke('get-auth'),
    clearAuth: () => ipcRenderer.invoke('clear-auth'),

    // Feature 16: Multi-Account
    getAccounts: () => ipcRenderer.invoke('get-accounts'),
    switchAccount: (uuid) => ipcRenderer.invoke('switch-account', uuid),
    removeAccount: (uuid) => ipcRenderer.invoke('remove-account', uuid),

    // Profiles
    getProfiles: () => ipcRenderer.invoke('get-profiles'),
    saveProfiles: (profiles) => ipcRenderer.invoke('save-profiles', profiles),
    createProfile: (data) => ipcRenderer.invoke('create-profile', data),
    deleteProfile: (name) => ipcRenderer.invoke('delete-profile', name),
    duplicateProfile: (data) => ipcRenderer.invoke('duplicate-profile', data),
    openProfileFolder: (name) => ipcRenderer.invoke('open-profile-folder', name),

    // External Import
    scanExternalInstances: () => ipcRenderer.invoke('scan-external-instances'),
    importExternalInstance: (data) => ipcRenderer.invoke('import-external-instance', data),

    // Feature 19: Export/Import
    exportProfile: (name) => ipcRenderer.invoke('export-profile', name),
    importProfile: () => ipcRenderer.invoke('import-profile'),
    exportMrpack: (data) => ipcRenderer.invoke('export-mrpack', data),

    // Mods
    getInstalledMods: (profileName) => ipcRenderer.invoke('get-installed-mods', profileName),
    toggleMod: (profileName, filename) => ipcRenderer.invoke('toggle-mod', { profileName, filename }),
    deleteMod: (profileName, filename) => ipcRenderer.invoke('delete-mod', { profileName, filename }),
    downloadMod: (data) => ipcRenderer.send('download-mod', data),

    // Feature 4: Shaders & Resource Packs
    getShaderPacks: (pn) => ipcRenderer.invoke('get-shaderpacks', pn),
    getResourcePacks: (pn) => ipcRenderer.invoke('get-resourcepacks', pn),
    toggleShaderPack: (pn, fn) => ipcRenderer.invoke('toggle-shaderpack', { profileName: pn, filename: fn }),
    toggleResourcePack: (pn, fn) => ipcRenderer.invoke('toggle-resourcepack', { profileName: pn, filename: fn }),
    deleteShaderPack: (pn, fn) => ipcRenderer.invoke('delete-shaderpack', { profileName: pn, filename: fn }),
    deleteResourcePack: (pn, fn) => ipcRenderer.invoke('delete-resourcepack', { profileName: pn, filename: fn }),

    // Feature 2: Mod Updates
    checkModUpdates: (data) => ipcRenderer.invoke('check-mod-updates', data),
    updateMod: (data) => ipcRenderer.invoke('update-mod', data),

    // Feature 3: Mod Conflicts
    checkModConflicts: (data) => ipcRenderer.invoke('check-mod-conflicts', data),
    fixModConflicts: (data) => ipcRenderer.invoke('fix-mod-conflicts', data),

    // P2P Networking
    p2pFetchPublic: () => ipcRenderer.invoke('p2p-fetch-public'),
    p2pJoin: (code) => ipcRenderer.invoke('p2p-join', { code }),
    p2pGetInfo: (code) => ipcRenderer.invoke('p2p-get-info', { code }),
    onP2PStatus: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('p2p-status', handler);
        return () => ipcRenderer.removeListener('p2p-status', handler);
    },

    // Game
    startGame: (options) => ipcRenderer.send('start-minecraft', options),
    stopGame: () => ipcRenderer.send('stop-minecraft'),

    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getSystemMemory: () => ipcRenderer.invoke('get-system-memory'),

    // Feature 7: Performance
    getPerformance: () => ipcRenderer.invoke('get-performance'),

    // Feature 15: Servers
    getServers: () => ipcRenderer.invoke('get-servers'),
    saveServers: (servers) => ipcRenderer.invoke('save-servers', servers),
    pingServer: (data) => ipcRenderer.invoke('ping-server', data),

    // Feature 11: Screenshots
    getScreenshots: (pn) => ipcRenderer.invoke('get-screenshots', pn),
    getScreenshotData: (fp) => ipcRenderer.invoke('get-screenshot-data', fp),
    copyScreenshot: (fp) => ipcRenderer.invoke('copy-screenshot', fp),
    deleteScreenshot: (fp) => ipcRenderer.invoke('delete-screenshot', fp),
    openScreenshotFolder: (fp) => ipcRenderer.invoke('open-screenshot-folder', fp),

    // Feature 12: Desktop Shortcut
    createShortcut: (data) => ipcRenderer.invoke('create-shortcut', data),

    // Feature 17: Crash Analyzer
    analyzeCrash: (pn) => ipcRenderer.invoke('analyze-crash', pn),

    // Feature 18: Game Logs
    getGameLog: (pn) => ipcRenderer.invoke('get-game-log', pn),

    // Feature 20: Portable
    getPortableStatus: () => ipcRenderer.invoke('get-portable-status'),
    enablePortable: () => ipcRenderer.invoke('enable-portable'),

    // Feature 5: Java Info
    getJavaInfo: () => ipcRenderer.invoke('get-java-info'),

    // Stats & Background
    getStats: () => ipcRenderer.invoke('get-stats'),
    chooseBackgroundImage: () => ipcRenderer.invoke('choose-background-image'),

    // Events
    onLauncherEvent: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('launcher-event', handler);
        return () => ipcRenderer.removeListener('launcher-event', handler);
    },
    
    // Feature 1
    getFpsBoosterMods: (args) => ipcRenderer.invoke('get-fps-booster-mods', args),
    installFpsBooster: (args) => ipcRenderer.invoke('install-fps-booster', args),
    installWizardMods: (args) => ipcRenderer.invoke('install-wizard-mods', args),
    // Feature 2
    getWorlds: (args) => ipcRenderer.invoke('get-worlds', args),
    backupWorld: (args) => ipcRenderer.invoke('backup-world', args),
    restoreWorldBackup: (args) => ipcRenderer.invoke('restore-world-backup', args),
    getWorldBackups: (args) => ipcRenderer.invoke('get-world-backups', args),
    deleteWorld: (args) => ipcRenderer.invoke('delete-world', args),
    duplicateWorld: (args) => ipcRenderer.invoke('duplicate-world', args),
    autoBackupBeforeLaunch: (args) => ipcRenderer.invoke('auto-backup-before-launch', args),
    // Feature 3
    getConfigFiles: (args) => ipcRenderer.invoke('get-config-files', args),
    readConfigFile: (args) => ipcRenderer.invoke('read-config-file', args),
    saveConfigFile: (args) => ipcRenderer.invoke('save-config-file', args),
    readOptionsTxt: (args) => ipcRenderer.invoke('read-options-txt', args),
    saveOptionsTxt: (args) => ipcRenderer.invoke('save-options-txt', args),
    // Feature 4
    createSyncLink: (args) => ipcRenderer.invoke('create-sync-link', args),
    applySyncLink: (args) => ipcRenderer.invoke('apply-sync-link', args),
    // Feature 5
    getModpackSuggestions: (args) => ipcRenderer.invoke('get-modpack-suggestions', args),
    // Feature 6
    autoRepairMods: (args) => ipcRenderer.invoke('auto-repair-mods', args),
    // Feature 7
    getGcAnalysis: (args) => ipcRenderer.invoke('get-gc-analysis', args),
    // Feature 8
    chooseVideoBackground: () => ipcRenderer.invoke('choose-video-background'),
    getSoundEffectsEnabled: () => ipcRenderer.invoke('get-sound-effects-enabled'),
    saveSoundEffectsEnabled: (args) => ipcRenderer.invoke('save-sound-effects-enabled', args),
    // Feature 10
    installControllerMod: (args) => ipcRenderer.invoke('install-controller-mod', args)
});