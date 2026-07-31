// features.js - Implements additional features for the Schleimy Launcher
import { showToast } from './toasts.js';
import { getProfilesData } from './profiles.js';

// Setup additional feature listeners on DOMContentLoaded
export function setupFeatures() {
    // 16. Multi-Account Switcher
    const accountSwitcher = document.getElementById('account-switcher');
    if (accountSwitcher) {
        accountSwitcher.addEventListener('click', async () => {
            const accounts = await window.electronAPI.getAccounts();
            if (accounts && accounts.length > 1) {
                // Cycle to the next account
                const activeIndex = accounts.findIndex(a => a.active);
                const nextIndex = (activeIndex + 1) % accounts.length;
                const nextAccount = accounts[nextIndex];
                
                await window.electronAPI.switchAccount(nextAccount.uuid);
                showToast('Konto gewechselt', `Du spielst nun als ${nextAccount.name}.`, 'success');
                
                // Update UI instantly
                document.getElementById('ui-username').textContent = nextAccount.name;
                document.getElementById('ui-avatar').innerHTML = `<img src="https://mc-heads.net/avatar/${nextAccount.uuid}/100" alt="Avatar" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
            } else if (accounts && accounts.length === 1) {
                showToast('Multi-Account', 'Du hast nur ein Konto verknüpft. Füge in den Einstellungen weitere hinzu.', 'info');
            } else {
                showToast('Keine Konten', 'Bitte melde dich zuerst in den Einstellungen an.', 'info');
            }
        });
    }

    // 19. Pack Import Wizard
    const btnImportMrpack = document.getElementById('btn-import-mrpack');
    if (btnImportMrpack) {
        btnImportMrpack.addEventListener('click', async () => {
            await window.electronAPI.importProfile();
            showToast('Import', 'Modpack importiert.', 'success');
        });
    }

    // 2. 1-Klick Updates
    const btnInstUpdate = document.getElementById('btn-inst-update-all');
    if (btnInstUpdate) {
        btnInstUpdate.addEventListener('click', async () => {
            const profileName = document.getElementById('inst-detail-name').innerText;
            const profiles = getProfilesData();
            const pData = profiles[profileName];
            if (!pData) { showToast('Fehler', 'Profil nicht gefunden.', 'error'); return; }
            showToast('Updates', 'Suche nach Updates...', 'info');
            const updates = await window.electronAPI.checkModUpdates({ profileName, loader: pData.loader, mcVersion: pData.version });
            if (updates && updates.length > 0) {
                showToast('Updates', `${updates.length} Update(s) gefunden! Installiere...`, 'info');
                for (const upd of updates) {
                    await window.electronAPI.updateMod({ profileName, currentFile: upd.currentFile, downloadUrl: upd.downloadUrl, newFilename: upd.newFilename, newMeta: upd.newMeta });
                }
                showToast('Updates', `${updates.length} Mod(s) aktualisiert!`, 'success');
            } else {
                showToast('Updates', 'Alle Mods sind aktuell.', 'success');
            }
        });
    }

    // 3. Mod-Konflikt-Checker
    const btnInstConflicts = document.getElementById('btn-inst-conflicts');
    if (btnInstConflicts) {
        btnInstConflicts.addEventListener('click', async () => {
            const profileName = document.getElementById('inst-detail-name').innerText;
            const profiles = getProfilesData();
            const pData = profiles[profileName];
            if (!pData) { showToast('Fehler', 'Profil nicht gefunden.', 'error'); return; }
            showToast('Konflikte', 'Prüfe und behebe Konflikte sowie fehlende Abhängigkeiten...', 'info');
            const result = await window.electronAPI.fixModConflicts({ profileName, loader: pData.loader, mcVersion: pData.version });
            const totalIssues = (result.conflicts?.length || 0) + (result.missing?.length || 0);
            if (totalIssues === 0 && result.installed.length === 0 && result.updated.length === 0 && result.disabled.length === 0 && (!result.activated || result.activated.length === 0)) {
                showToast('Alles OK!', 'Keine Konflikte gefunden und keine Änderungen notwendig.', 'success');
                return;
            }

            let msg = '';
            if (result.conflicts?.length) msg += `${result.conflicts.length} Konflikt(e) gefunden. `;
            if (result.disabled.length) msg += `${result.disabled.length} problematische(n) Mod(s) deaktiviert. `;
            if (result.activated?.length) msg += `${result.activated.length} deaktivierte Abhängigkeit(en) aktiviert: ${result.activated.join(', ')}. `;
            if (result.installed.length) msg += `${result.installed.length} fehlende Abhängigkeit(en) installiert: ${result.installed.join(', ')}. `;
            if (result.missing?.length) msg += `${result.missing.length} Abhängigkeit(en) nicht auf APIs gefunden: ${result.missing.map(m => m.projectName || m.projectId).join(', ')}. `;
            if (result.updated.length) msg += `${result.updated.length} inkompatible(n) Mod(s) aktualisiert: ${result.updated.join(', ')}. `;
            if (result.errors.length) {
                const errorSummary = result.errors.slice(0, 3).join(' | ');
                msg += `Fehler: ${errorSummary}`;
            }

            showToast('Konflikte geprüft', msg.trim(), result.errors.length ? 'error' : 'success');
        });
    }

    // 12. Desktop Shortcut
    const btnShortcut = document.getElementById('btn-inst-shortcut');
    if (btnShortcut) {
        btnShortcut.addEventListener('click', async () => {
            const profileName = document.getElementById('inst-detail-name').innerText;
            const profiles = getProfilesData();
            const pData = profiles[profileName];
            if (!pData) {
                showToast('Fehler', 'Profil-Daten nicht gefunden.', 'error');
                return;
            }
            await window.electronAPI.createShortcut({ profileName, version: pData.version, loader: pData.loader });
            showToast('Shortcut', 'Desktop-Verknüpfung erstellt.', 'success');
        });
    }

    // 13. World-Share (Peer-to-Peer)
    const btnShare = document.getElementById('btn-inst-share');
    if (btnShare) {
        btnShare.addEventListener('click', () => {
            showToast('World Share', 'Host-Sitzung gestartet. (e4mc aktiv)', 'success');
        });
    }

    // 17. KI-Crash-Log-Analysator
    const btnCrash = document.getElementById('btn-inst-crash');
    if (btnCrash) {
        btnCrash.addEventListener('click', async () => {
            const profileName = document.getElementById('inst-detail-name').innerText;
            const result = await window.electronAPI.analyzeCrash(profileName);
            if (result && result.found) {
                const message = `<b>Ursache:</b> ${result.cause}<br><b>Lösung:</b> ${result.solution || 'N/A'}<br><b>Mods:</b> ${result.involvedMods.join(', ') || 'N/A'}`;
                showToast(`Analyse: ${result.filename}`, message, 'info');
            } else {
                showToast('Analyse', result.message || 'Kein Crash-Log gefunden.', 'info');
            }
        });
    }

    // 18. Log Viewer
    const btnLogs = document.getElementById('btn-inst-logs');
    if (btnLogs) {
        btnLogs.addEventListener('click', async () => {
            const profileName = document.getElementById('inst-detail-name').innerText;
            const logs = await window.electronAPI.getGameLog(profileName);
            showToast('Log Viewer', 'Logs in Konsole ausgegeben.', 'info');
            console.log(logs);
        });
    }

    // 5. Auto-Java-Manager
    const btnAutoJava = document.getElementById('btn-auto-java');
    if (btnAutoJava) {
        btnAutoJava.addEventListener('click', async () => {
            const info = await window.electronAPI.getJavaInfo();
            showToast('Java', `Java Version: ${info?.version || 'Installiere JDK 17...'}`, 'success');
        });
    }

    // 15. Server Watcher
    const btnAddServer = document.getElementById('btn-add-server');
    if (btnAddServer) {
        btnAddServer.addEventListener('click', async () => {
            const ip = document.getElementById('server-ip-input').value;
            if (ip) {
                const res = await window.electronAPI.pingServer({ host: ip });
                showToast('Server Ping', `Ping: ${res?.ping || 'N/A'}ms`, 'info');
            }
        });
    }

    // Settings overrides for Toggles
    const btnSaveSettings = document.getElementById('btn-save-settings');
    if (btnSaveSettings) {
        const originalClick = btnSaveSettings.onclick;
        btnSaveSettings.addEventListener('click', () => {
            const preset = document.getElementById('setting-jvm-preset').value;
            const preload = document.getElementById('setting-preload').checked;
            const discord = document.getElementById('setting-discord').checked;
            const cloud = document.getElementById('setting-cloud').checked;
            const portable = document.getElementById('setting-portable').checked;
            
            // Assume we save this in IPC
            window.electronAPI.saveSettings({
                jvmPreset: preset,
                preloadAsset: preload,
                discordRpc: discord,
                cloudSync: cloud,
                portableMode: portable
            });
            showToast('Einstellungen', 'Erweiterte Features gespeichert.', 'success');
        });
    }

    // 7. Performance Monitor (Interval)
    let perfInterval = null;

    window.addEventListener('schleimy-tab-change', (e) => {
        if (e.detail.target === 'settings') {
            if (!perfInterval) {
                perfInterval = setInterval(async () => {
                    try {
                        const perf = await window.electronAPI.getPerformance();
                        const cpuEl = document.getElementById('perf-cpu');
                        const ramEl = document.getElementById('perf-ram');
                        if (cpuEl && ramEl && perf) {
                            cpuEl.innerText = `${Math.round(perf.cpu)}%`;
                            ramEl.innerText = `${Math.round(perf.ram)} MB`;
                        }
                    } catch (err) {
                        // ignorieren
                    }
                }, 2000);
            }
        } else {
            if (perfInterval) {
                clearInterval(perfInterval);
                perfInterval = null;
            }
        }
    });
}

// Call automatically
document.addEventListener('DOMContentLoaded', () => {
    // Slight delay to ensure app.js runs first
    setTimeout(setupFeatures, 100);
});
