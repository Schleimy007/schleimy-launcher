import { initUI } from './ui.js';
import { loadProfiles, createProfile, getProfilesData, renderScreenshotTab } from './profiles.js';
import { initDiscover } from './discover.js';
import { fetchMojangVersions } from './api.js';
import { showToast, updateToastProgress } from './toasts.js';
import { initCommunityTab } from './community.js';

let sysMemoryGB = 4;
let isGameRunning = false;

document.addEventListener('DOMContentLoaded', async () => {
    try { initUI(); } catch(e) { console.error('initUI failed:', e); }
    window.addEventListener('schleimy-tab-change', async (e) => {
        if (e.detail.target === 'screenshots') {
            try { await renderScreenshotTab(); } catch (err) { console.error('renderScreenshotTab failed:', err); }
        }
    });
    try { initCommunityTab(); } catch(e) { console.error('initCommunityTab failed:', e); }
    
    // --- Setup Global Listeners ---
    try { setupEventListeners(); } catch(e) { console.error('setupEventListeners failed:', e); }
    try { setupIpcListeners(); } catch(e) { console.error('setupIpcListeners failed:', e); }

    // --- Initial Data Load ---
    await loadInitialData();

    // Clear the HTML failsafe timer since we loaded successfully
    if (window.__loaderFailsafe) clearTimeout(window.__loaderFailsafe);
});

async function loadInitialData() {
    const loader = document.getElementById('startup-loader');
    
    // HARD TIMEOUT: No matter what, hide the loader after 8 seconds
    const failsafe = setTimeout(() => {
        if (loader && loader.style.display !== 'none') {
            console.warn('Failsafe: hiding loader after timeout');
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 500);
        }
    }, 8000);

    try {
        // 1. Auth Status
        try {
            const auth = await window.electronAPI.getAuth();
            updateAuthUI(auth);
        } catch (e) { console.error('Auth load failed:', e); }

        // 2. Settings & Memory
        let settings = {};
        try {
            settings = await window.electronAPI.getSettings() || {};
            sysMemoryGB = await window.electronAPI.getSystemMemory() || 4;
            
            const ramSlider = document.getElementById('setting-ram');
            if (ramSlider) {
                ramSlider.max = sysMemoryGB;
                ramSlider.value = settings.ram || 4;
                const ramVal = document.getElementById('setting-ram-val');
                if (ramVal) ramVal.textContent = `${ramSlider.value} GB`;
            }
            const sysRam = document.getElementById('sys-ram');
            if (sysRam) sysRam.textContent = sysMemoryGB;
            
            if (settings.javaPath) {
                const javaInput = document.getElementById('setting-java');
                if (javaInput) javaInput.value = settings.javaPath;
            }
        } catch (e) { console.error('Settings load failed:', e); }

        // 3. Profiles
        try {
            await loadProfiles();
            if (document.querySelector('.nav-item.active')?.dataset.tab === 'screenshots') {
                await renderScreenshotTab();
            }
        } catch (e) { console.error('Profile load failed:', e); }

        // 4. Minecraft Versions (network, can be slow)
        try {
            const mcVersions = await fetchMojangVersions();
            populateVersionSelects(mcVersions);
        } catch (e) { console.error('MC versions load failed:', e); }

        // 5. Init Discover logic
        try {
            initDiscover(getProfilesData);
            document.getElementById('search-input')?.dispatchEvent(new Event('input'));
        } catch (e) { console.error('Discover init failed:', e); }
        
        // 6. Setup Wizard & Splash Screen
        if (!settings.setupCompleted) {
            loader.style.display = 'none';
            const wizard = document.getElementById('setup-wizard');
            if (wizard) wizard.style.display = 'flex';
            initSetupWizard();
        } else {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 500);
        }
    } catch (e) {
        console.error('Startup error:', e);
        // Even on total failure, hide the loader so the app is usable
        loader.style.opacity = '0';
        setTimeout(() => loader.style.display = 'none', 500);
    }

    clearTimeout(failsafe);
}

async function initSetupWizard() {
    const s = await window.electronAPI.getSettings();
    if (!s.setupCompleted) {
        s.setupCompleted = true;
        await window.electronAPI.saveSettings(s);
    }

    const list = document.getElementById('setup-instances-list');
    list.innerHTML = '<div style="text-align:center; padding: 20px;">Suche externe Profile...</div>';
    
    const instances = await window.electronAPI.scanExternalInstances();
    if (instances.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding: 20px;">Keine Profile von CurseForge oder Modrinth gefunden.</div>';
    } else {
        list.innerHTML = '';
        instances.forEach(inst => {
            const div = document.createElement('div');
            div.className = 'setup-list-item selected';
            div.innerHTML = `
                <div>
                    <strong>${inst.name}</strong>
                    <div style="font-size:12px; color:var(--color-text-med);">${inst.source} (${inst.path})</div>
                </div>
                <input type="checkbox" checked style="pointer-events:none;">
            `;
            div.onclick = () => {
                div.classList.toggle('selected');
                div.querySelector('input').checked = div.classList.contains('selected');
            };
            div.dataset.path = inst.path;
            div.dataset.name = inst.name;
            div.dataset.source = inst.source;
            list.appendChild(div);
        });
    }

    const finishSetup = async () => {
        const s = await window.electronAPI.getSettings();
        s.setupCompleted = true;
        await window.electronAPI.saveSettings(s);
        
        const wizard = document.getElementById('setup-wizard');
        wizard.style.opacity = '0';
        setTimeout(() => wizard.style.display = 'none', 500);
    };

    document.getElementById('btn-setup-skip').onclick = finishSetup;

    document.getElementById('btn-setup-import').onclick = async () => {
        const selected = Array.from(list.querySelectorAll('.setup-list-item.selected'));
        if (selected.length === 0) return finishSetup();
        
        const btn = document.getElementById('btn-setup-import');
        const skipBtn = document.getElementById('btn-setup-skip');
        btn.disabled = true;
        skipBtn.disabled = true;
        btn.textContent = 'Importiere... (bitte warten)';
        
        for (const item of selected) {
            await window.electronAPI.importExternalInstance({
                sourcePath: item.dataset.path,
                name: item.dataset.name,
                source: item.dataset.source
            });
        }
        
        await loadProfiles();
        finishSetup();
    };
}

function updateAuthUI(auth) {
    const avatar = document.getElementById('ui-avatar');
    const username = document.getElementById('ui-username');
    const status = document.getElementById('ui-authstatus');
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const btnPlay = document.getElementById('btn-play');

    if (auth) {
        username.textContent = auth.name;
        avatar.innerHTML = `<img src="https://mc-heads.net/avatar/${auth.uuid}/100" alt="Avatar" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
        status.textContent = 'Angemeldet';
        status.className = 'user-status';
        btnLogin.style.display = 'none';
        btnLogout.style.display = 'block';
        btnPlay.disabled = !document.getElementById('play-profile-select').value;
    } else {
        username.textContent = 'Gast';
        avatar.innerHTML = 'G';
        status.textContent = 'Nicht angemeldet';
        status.className = 'user-status offline';
        btnLogin.style.display = 'block';
        btnLogout.style.display = 'none';
        btnPlay.disabled = true;
    }
}

function populateVersionSelects(versions) {
    const createSel = document.getElementById('create-version');
    const filterSel = document.getElementById('filter-version');
    
    createSel.innerHTML = '';
    filterSel.innerHTML = '<option value="">Alle Versionen</option>';

    versions.filter(v => v.type === 'release').forEach(v => {
        createSel.innerHTML += `<option value="${v.id}">${v.id}</option>`;
        filterSel.innerHTML += `<option value="${v.id}">${v.id}</option>`;
    });
}

function setupEventListeners() {
    // Window Controls
    document.getElementById('win-min')?.addEventListener('click', () => window.electronAPI.windowMinimize());
    document.getElementById('win-max')?.addEventListener('click', () => window.electronAPI.windowMaximize());
    document.getElementById('win-close')?.addEventListener('click', () => window.electronAPI.windowClose());

    // Profile Selection in Play Bar
    const playSelect = document.getElementById('play-profile-select');
    playSelect.addEventListener('change', () => {
        const val = playSelect.value;
        const nameDisplay = document.getElementById('play-selected-name');
        const statusDisplay = document.getElementById('play-status-text');
        const playBtn = document.getElementById('btn-play');
        const authStatus = document.getElementById('ui-authstatus').classList.contains('offline');

        if (val) {
            nameDisplay.textContent = val;
            const p = getProfilesData()[val];
            statusDisplay.textContent = `Bereit (${p.loader} ${p.version})`;
            if (!authStatus) playBtn.disabled = false;
        } else {
            nameDisplay.textContent = 'Kein Profil gewählt';
            statusDisplay.textContent = 'Warte auf Auswahl...';
            playBtn.disabled = true;
        }

        const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
        if (activeTab === 'screenshots') {
            renderScreenshotTab();
        }
    });

    // Game Launch
    document.getElementById('btn-play').addEventListener('click', () => {
        const btn = document.getElementById('btn-play');

        if (isGameRunning) {
            window.electronAPI.stopGame();
            btn.disabled = true;
            btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor;"><path d="M6 6h12v12H6z"/></svg> BEENDET...`;
            return;
        }

        const profile = document.getElementById('play-profile-select').value;
        const pData = getProfilesData()[profile];
        if (!profile || !pData) return;

        btn.disabled = true;
        btn.classList.add('loading');
        btn.innerHTML = `STARTET...`;

        window.electronAPI.startGame({
            profileName: profile,
            version: pData.version,
            loader: pData.loader
        });
    });

    // Auth
    document.getElementById('btn-login').addEventListener('click', async () => {
        const btn = document.getElementById('btn-login');
        btn.disabled = true;
        btn.textContent = 'Warte auf Login...';
        
        const res = await window.electronAPI.loginMicrosoft();
        if (res.success) {
            showToast('Erfolg', `Eingeloggt als ${res.name}`, 'success');
            updateAuthUI(res);
        } else {
            showToast('Fehler', res.error, 'error');
            btn.disabled = false;
            btn.textContent = 'Anmelden';
        }
    });

    document.getElementById('btn-logout').addEventListener('click', async () => {
        await window.electronAPI.clearAuth();
        updateAuthUI(null);
        showToast('Info', 'Erfolgreich abgemeldet.', 'info');
    });

    // Create Instance
    document.getElementById('btn-create-confirm').addEventListener('click', async () => {
        const btn = document.getElementById('btn-create-confirm');
        btn.disabled = true;
        
        const name = document.getElementById('create-name').value.trim();
        const loader = document.getElementById('create-loader').value;
        const version = document.getElementById('create-version').value;
        const hostMode = document.getElementById('new-inst-hostmode').value;
        
        await createProfile(name, loader, version, hostMode);
        btn.disabled = false;
    });

    // Settings
    const ramSlider = document.getElementById('setting-ram');
    const ramVal = document.getElementById('setting-ram-val');
    ramSlider.addEventListener('input', () => {
        ramVal.textContent = `${ramSlider.value} GB`;
    });

    document.getElementById('btn-save-settings').addEventListener('click', async () => {
        const btn = document.getElementById('btn-save-settings');
        btn.disabled = true;
        
        await window.electronAPI.saveSettings({
            ram: parseInt(document.getElementById('setting-ram').value),
            javaPath: document.getElementById('setting-java').value.trim()
        });
        
        showToast('Erfolg', 'Einstellungen gespeichert', 'success');
        setTimeout(() => btn.disabled = false, 500);
    });
}

function setupIpcListeners() {
    window.electronAPI.onLauncherEvent((evt) => {
        const statusDisplay = document.getElementById('play-status-text');
        
        if (evt.type === 'progress') {
            statusDisplay.textContent = evt.message;
            updateToastProgress(evt.message);
        } 
        else if (evt.type === 'update-start') {
            document.getElementById('startup-loader').style.display = 'none';
            document.getElementById('update-overlay').style.display = 'flex';
            document.getElementById('update-status-text').textContent = 'Lade Update herunter... (0%)';
        }
        else if (evt.type === 'public-server-found') {
            window.dispatchEvent(new CustomEvent('public-server-found', { detail: evt.data }));
        }
        else if (evt.type === 'update-progress') {
            const pct = Math.round(evt.data?.percent || 0);
            document.getElementById('update-progress-bar').style.width = pct + '%';
            document.getElementById('update-status-text').textContent = `Lade Update herunter... (${pct}%)`;
        }
        else if (evt.type === 'update-ready') {
            document.getElementById('update-progress-bar').style.width = '100%';
            document.getElementById('update-status-text').textContent = 'Update bereit! Starte neu...';
        }
        else if (evt.type === 'game-started') {
            statusDisplay.textContent = '🚀 Spiel läuft!';
            showToast('Spiel gestartet', 'Minecraft wird geöffnet...', 'success');
            isGameRunning = true;
            const btn = document.getElementById('btn-play');
            btn.classList.remove('loading');
            btn.classList.add('stop');
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor;"><path d="M6 6h12v12H6z"/></svg> STOP`;
        }
        else if (evt.type === 'game-closed') {
            statusDisplay.textContent = 'Spiel beendet.';
            isGameRunning = false;
            const btn = document.getElementById('btn-play');
            btn.classList.remove('loading', 'stop');
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor;"><path d="M8 5v14l11-7z"/></svg> SPIELEN`;
        }
        else if (evt.type === 'error') {
            statusDisplay.textContent = 'Fehler aufgetreten.';
            showToast('Fehler', evt.message, 'error');
            isGameRunning = false;
            const btn = document.getElementById('btn-play');
            btn.classList.remove('loading', 'stop');
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor;"><path d="M8 5v14l11-7z"/></svg> SPIELEN`;
        }
        else if (evt.type === 'download-progress') {
            // Check if we have progress percentage
            const safeName = evt.data.fileName.replace(/[^a-zA-Z0-9]/g, '-');
            if (evt.data.progress !== undefined) {
                showToast(`Download: ${evt.data.fileName}`, evt.message, 'progress', safeName);
                updateToastProgress(safeName, evt.data.progress);
            } else {
                showToast(`Download: ${evt.data.fileName}`, evt.message, 'info');
            }
        }
        else if (evt.type === 'success') {
            const safeName = evt.data?.fileName ? evt.data.fileName.replace(/[^a-zA-Z0-9]/g, '-') : null;
            if (safeName) {
                // Change progress toast to success
                showToast(`Abgeschlossen`, evt.message, 'success', safeName);
            } else {
                showToast('Erfolg', evt.message, 'success');
            }
        }
        else if (evt.type === 'info') {
            showToast('Info', evt.message, 'info');
        }
    });

    if (window.electronAPI.onP2PStatus) {
        window.electronAPI.onP2PStatus((data) => {
            if (data.hosting) {
                showToast('P2P Host Aktiv!', `Andere können per Code beitreten: ${data.code}`, 'success');
            }
        });
    }
}
