import { showToast } from './toasts.js';
import { openInstanceModal, closeModals } from './ui.js';

let currentProfiles = {};

export async function loadProfiles() {
    currentProfiles = await window.electronAPI.getProfiles();
    renderProfiles();
    updatePlaySelect();
    return currentProfiles;
}

export function getProfilesData() {
    return currentProfiles;
}

function renderProfiles() {
    const grid = document.getElementById('instances-grid');
    grid.innerHTML = '';
    
    if (Object.keys(currentProfiles).length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <svg class="empty-icon" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12l8-4-8-4-8 4 8 4zm0 0v8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
                <h3 style="color:var(--color-text-high);">Keine Instanzen gefunden</h3>
                <p>Erstelle oben rechts eine neue Instanz, um zu beginnen.</p>
            </div>`;
        return;
    }

    Object.entries(currentProfiles).forEach(([name, data], index) => {
        const card = document.createElement('div');
        card.className = 'card instance-card';
        card.style.animationDelay = `${index * 20}ms`;
        
        let loaderColor = '#10B981';
        if (data.loader === 'fabric') loaderColor = '#EBD2A9';
        else if (data.loader === 'forge') loaderColor = '#DFA86A';
        
        card.style.borderTop = `3px solid ${loaderColor}`;
        
        card.innerHTML = `
            <div class="instance-card-header">
                <div>
                    <h3 style="margin-bottom: 4px;">${name}</h3>
                    <div class="mod-meta">
                        <span class="badge" style="color:${loaderColor}; border-color:${loaderColor}40;">${data.loader.toUpperCase()}</span>
                        <span class="badge">${data.version}</span>
                    </div>
                </div>
                <div class="instance-actions">
                    <button class="btn btn-icon btn-secondary btn-play-quick" title="Schnellstart">
                        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
                    </button>
                </div>
            </div>
        `;
        
        card.addEventListener('click', (e) => {
            if (e.target.closest('.btn-play-quick')) {
                // Set as active and click play (handled in app.js)
                document.getElementById('play-profile-select').value = name;
                document.getElementById('play-profile-select').dispatchEvent(new Event('change'));
                document.getElementById('btn-play').click();
                return;
            }
            openInstanceDetails(name);
        });
        
        grid.appendChild(card);
    });
}

function updatePlaySelect() {
    const select = document.getElementById('play-profile-select');
    const currentVal = select.value;
    select.innerHTML = '<option value="">Profil wählen...</option>';
    
    Object.entries(currentProfiles).forEach(([name, data]) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${name} (${data.loader} ${data.version})`;
        select.appendChild(opt);
    });
    
    if (currentProfiles[currentVal]) {
        select.value = currentVal;
    }
}

export async function createProfile(name, loader, version) {
    if (!name || !version) {
        showToast('Fehler', 'Bitte Name und Version angeben', 'error');
        return false;
    }
    
    const res = await window.electronAPI.createProfile({ name, loader, version });
    if (res.success) {
        showToast('Erfolg', `Instanz ${name} erstellt`, 'success');
        closeModals();
        await loadProfiles();
        
        // Auto-select new profile
        document.getElementById('play-profile-select').value = name;
        document.getElementById('play-profile-select').dispatchEvent(new Event('change'));
        
        document.getElementById('create-name').value = '';
        return true;
    } else {
        showToast('Fehler', res.error, 'error');
        return false;
    }
}

// Instance details / Mod management
let currentActiveInstance = null;

async function openInstanceDetails(name) {
    currentActiveInstance = name;
    openInstanceModal(name);
    
    // Setup tab switching
    document.querySelectorAll('.tab-header').forEach(header => {
        // Remove old listeners to avoid duplicates
        const newHeader = header.cloneNode(true);
        header.parentNode.replaceChild(newHeader, header);
        
        newHeader.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-header').forEach(h => {
                h.classList.remove('active');
                h.style.color = 'var(--color-text-med)';
            });
            e.target.classList.add('active');
            e.target.style.color = 'inherit';
            
            document.querySelectorAll('.addon-list').forEach(list => {
                list.style.display = 'none';
            });
            document.getElementById(e.target.dataset.target).style.display = 'flex';
        });
    });

    await renderInstalledMods(name);
    await renderAddons(name, 'inst-shaders-list', 'getShaderPacks', 'toggleShaderPack', 'deleteShaderPack', 'Keine Shaders installiert.');
    await renderAddons(name, 'inst-rp-list', 'getResourcePacks', 'toggleResourcePack', 'deleteResourcePack', 'Keine Resource Packs installiert.');
}

async function renderAddons(profileName, listId, getIpc, toggleIpc, deleteIpc, emptyMsg) {
    const list = document.getElementById(listId);
    list.innerHTML = '<p style="padding:8px; text-align:center; color:var(--color-text-med);">Lade...</p>';
    
    // window.electronAPI[getIpc]
    const items = await window.electronAPI[getIpc](profileName);
    list.innerHTML = '';
    
    if (items.length === 0) {
        list.innerHTML = `<p style="padding:16px; text-align:center; color:var(--color-text-med);">${emptyMsg}</p>`;
        return;
    }
    
    items.forEach(item => {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.alignItems = 'center';
        div.style.padding = '12px';
        div.style.background = 'var(--color-bg-input)';
        div.style.borderRadius = 'var(--radius-md)';
        div.style.opacity = item.enabled ? '1' : '0.6';
        
        div.innerHTML = `
            <div>
                <div style="font-weight:600; color:${item.enabled ? 'white' : 'var(--color-text-med)'}">${item.displayName}</div>
                <div style="font-size:12px; color:var(--color-text-med);">${(item.size / 1024 / 1024).toFixed(2)} MB</div>
            </div>
            <div style="display:flex; gap:8px;">
                <button class="btn btn-secondary btn-sm toggle-btn" style="padding:6px 12px; font-size:12px;">${item.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
                <button class="btn btn-danger btn-sm del-btn" style="padding:6px 12px; font-size:12px;">Löschen</button>
            </div>
        `;
        
        div.querySelector('.toggle-btn').addEventListener('click', async () => {
            const res = await window.electronAPI[toggleIpc](profileName, item.filename);
            if (res.success) {
                renderAddons(profileName, listId, getIpc, toggleIpc, deleteIpc, emptyMsg);
            } else {
                showToast('Fehler', res.error, 'error');
            }
        });
        
        div.querySelector('.del-btn').addEventListener('click', async () => {
            if (confirm(`Wirklich löschen?`)) {
                const res = await window.electronAPI[deleteIpc](profileName, item.filename);
                if (res.success) {
                    renderAddons(profileName, listId, getIpc, toggleIpc, deleteIpc, emptyMsg);
                } else {
                    showToast('Fehler', res.error, 'error');
                }
            }
        });
        
        list.appendChild(div);
    });
}

async function renderInstalledMods(name) {
    const list = document.getElementById('inst-mods-list');
    list.innerHTML = '<p style="padding:8px; text-align:center; color:var(--color-text-med);">Lade Mods...</p>';
    
    const mods = await window.electronAPI.getInstalledMods(name);
    list.innerHTML = '';
    
    if (mods.length === 0) {
        list.innerHTML = '<p style="padding:16px; text-align:center; color:var(--color-text-med);">Keine Mods installiert.</p>';
        return;
    }
    
    mods.forEach(mod => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '12px';
        item.style.background = 'var(--color-bg-input)';
        item.style.borderRadius = 'var(--radius-md)';
        item.style.opacity = mod.enabled ? '1' : '0.6';
        
        item.innerHTML = `
            <div>
                <div style="font-weight:600; color:${mod.enabled ? 'white' : 'var(--color-text-med)'}">${mod.displayName}</div>
                <div style="font-size:12px; color:var(--color-text-med);">${(mod.size / 1024 / 1024).toFixed(2)} MB</div>
            </div>
            <div style="display:flex; gap:8px;">
                <button class="btn btn-secondary btn-sm toggle-btn" style="padding:6px 12px; font-size:12px;">${mod.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
                <button class="btn btn-danger btn-sm del-btn" style="padding:6px 12px; font-size:12px;">Löschen</button>
            </div>
        `;
        
        item.querySelector('.toggle-btn').addEventListener('click', async () => {
            const res = await window.electronAPI.toggleMod(name, mod.filename);
            if (res.success) {
                renderInstalledMods(name);
            } else {
                showToast('Fehler', res.error, 'error');
            }
        });
        
        item.querySelector('.del-btn').addEventListener('click', async () => {
            if (confirm(`Mod ${mod.displayName} wirklich löschen?`)) {
                const res = await window.electronAPI.deleteMod(name, mod.filename);
                if (res.success) {
                    renderInstalledMods(name);
                } else {
                    showToast('Fehler', res.error, 'error');
                }
            }
        });
        
        list.appendChild(item);
    });
}

document.getElementById('btn-inst-folder').addEventListener('click', () => {
    if (currentActiveInstance) window.electronAPI.openProfileFolder(currentActiveInstance);
});

document.getElementById('btn-inst-export').addEventListener('click', async () => {
    if (currentActiveInstance) {
        showToast('Export', 'Profil wird komprimiert...', 'info');
        const res = await window.electronAPI.exportProfile(currentActiveInstance);
        if (res.success) {
            showToast('Erfolg', `Profil ${currentActiveInstance} erfolgreich exportiert`, 'success');
        } else if (!res.canceled) {
            showToast('Fehler', res.error, 'error');
        }
    }
});

document.getElementById('btn-inst-delete').addEventListener('click', async () => {
    if (currentActiveInstance && confirm(`Instanz ${currentActiveInstance} wirklich inkl. aller Mods und Welten löschen?`)) {
        const res = await window.electronAPI.deleteProfile(currentActiveInstance);
        if (res.success) {
            showToast('Gelöscht', `Instanz ${currentActiveInstance} gelöscht`, 'success');
            closeModals();
            await loadProfiles();
        } else {
            showToast('Fehler', res.error, 'error');
        }
    }
});

document.getElementById('btn-import-instance')?.addEventListener('click', async () => {
    showToast('Import', 'Wähle eine ZIP-Datei aus...', 'info');
    const res = await window.electronAPI.importProfile();
    if (res.success) {
        showToast('Erfolg', `Profil ${res.newName} erfolgreich importiert`, 'success');
        await loadProfiles();
        
        // Auto-select new profile
        document.getElementById('play-profile-select').value = res.newName;
        document.getElementById('play-profile-select').dispatchEvent(new Event('change'));
    } else if (!res.canceled) {
        showToast('Fehler', res.error, 'error');
    }
});
