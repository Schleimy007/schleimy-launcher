import { showToast } from './toasts.js';
import { openInstanceModal, closeModals } from './ui.js';

let currentProfiles = {};
let currentStats = {};

export async function loadProfiles() {
    currentProfiles = await window.electronAPI.getProfiles();
    try {
        currentStats = await window.electronAPI.getStats();
    } catch (e) {
        console.warn('Unable to load stats', e);
        currentStats = {};
    }
    renderProfiles();
    updatePlaySelect();
    return currentProfiles;
}

export function getProfilesData() {
    return currentProfiles;
}

function formatPlaytime(seconds) {
    if (!seconds || seconds <= 0) return '0m gespielt';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours > 0 ? `${hours}h ` : ''}${minutes}m gespielt`;
}

function renderEmptyScreenshotState(message) {
    return `
        <div class="empty-state" style="height: 220px;">
            <svg class="empty-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"></rect><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"></circle><polyline points="21 15 16 10 5 21" fill="none" stroke="currentColor" stroke-width="2"></polyline></svg>
            <p style="color:var(--color-text-med);">${message}</p>
        </div>`;
}

async function _renderScreenshotTab(profileName) {
    const container = document.getElementById('screenshot-grid');
    if (!container) return;
    container.innerHTML = '<p style="padding:16px; text-align:center; color:var(--color-text-med);">Lade Screenshots...</p>';

    const selectedProfile = profileName || document.getElementById('play-profile-select')?.value;
    if (!selectedProfile) {
        container.innerHTML = renderEmptyScreenshotState('Wähle ein Profil in der Leiste unten, um Screenshots anzuzeigen.');
        return;
    }

    let screenshots = [];
    try {
        screenshots = await window.electronAPI.getScreenshots(selectedProfile);
    } catch (err) {
        console.error('Screenshot fetch failed:', err);
        container.innerHTML = renderEmptyScreenshotState('Fehler beim Laden der Screenshots.');
        return;
    }

    if (!screenshots || screenshots.length === 0) {
        container.innerHTML = renderEmptyScreenshotState('Keine Screenshots gefunden.');
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'screenshot-grid';
    screenshots.forEach(ss => grid.appendChild(createScreenshotItem(ss, () => _renderScreenshotTab(selectedProfile))));
    container.innerHTML = '';
    container.appendChild(grid);
}

function createScreenshotItem(ss, refreshFn) {
    const item = document.createElement('div');
    item.className = 'screenshot-item';
    const imageUrl = `file:///${encodeURI(ss.path.replace(/\\/g, '/'))}`;

    item.innerHTML = `
        <img src="${imageUrl}" alt="${ss.filename}" loading="lazy">
        <div class="screenshot-actions">
            <button class="btn btn-icon btn-secondary btn-action-copy" title="In Zwischenablage kopieren">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <button class="btn btn-icon btn-secondary btn-action-open" title="Im Ordner anzeigen">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </button>
            <button class="btn btn-icon btn-danger btn-action-delete" title="Löschen">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </div>
    `;

    item.querySelector('.btn-action-copy').addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await window.electronAPI.copyScreenshot(ss.path);
        if (res.success) showToast('Erfolg', 'Screenshot kopiert!', 'success');
        else showToast('Fehler', res.error, 'error');
    });

    item.querySelector('.btn-action-open').addEventListener('click', (e) => {
        e.stopPropagation();
        window.electronAPI.openScreenshotFolder(ss.path);
    });

    item.querySelector('.btn-action-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Screenshot "${ss.filename}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) {
            const res = await window.electronAPI.deleteScreenshot(ss.path);
            if (res.success) {
                showToast('Gelöscht', 'Screenshot wurde entfernt.', 'info');
                if (typeof refreshFn === 'function') refreshFn();
                else item.remove();
            } else {
                showToast('Fehler', res.error, 'error');
            }
        }
    });

    return item;
}

export async function renderScreenshotTab(profileName) {
    return _renderScreenshotTab(profileName);
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
        
        const stat = currentStats[name] || {};
        card.innerHTML = `
            <div class="instance-card-header">
                <div>
                    <h3 style="margin-bottom: 4px;">${name}</h3>
                    <div class="mod-meta">
                        <span class="badge" style="color:${loaderColor}; border-color:${loaderColor}40;">${data.loader.toUpperCase()}</span>
                        <span class="badge">${data.version}</span>
                        <span class="badge stats-badge">${stat.playSeconds ? formatPlaytime(stat.playSeconds) : 'Noch nicht gespielt'}</span>
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

export async function createProfile(name, loader, version, hostMode = 'none') {
    if (!name || !version) {
        showToast('Fehler', 'Bitte Name und Version angeben', 'error');
        return false;
    }
    
    const res = await window.electronAPI.createProfile({ name, loader, version, hostMode });
    if (res.success) {
        showToast('Erfolg', `Instanz ${name} erstellt`, 'success');
        closeModals();
        await loadProfiles();
        
        document.getElementById('play-profile-select').value = name;
        document.getElementById('play-profile-select').dispatchEvent(new Event('change'));
        
        document.getElementById('create-name').value = '';
        return true;
    } else {
        showToast('Fehler', res.error, 'error');
        return false;
    }
}

let currentActiveInstance = null;

async function openInstanceDetails(name) {
    currentActiveInstance = name;
    const playSelect = document.getElementById('play-profile-select');
    if (playSelect && playSelect.value !== name) {
        playSelect.value = name;
        playSelect.dispatchEvent(new Event('change'));
    }
    const modal = document.getElementById('modal-instance');
    openInstanceModal(name);
    
    modal.querySelectorAll('.tab-header').forEach(header => {
        const newHeader = header.cloneNode(true);
        header.parentNode.replaceChild(newHeader, header);
        
        newHeader.addEventListener('click', (e) => {
            modal.querySelectorAll('.tab-header').forEach(h => {
                h.classList.remove('active');
            });
            e.target.classList.add('active');
            
            modal.querySelectorAll('.addon-list').forEach(list => {
                list.style.display = 'none';
            });
            const targetId = e.target.dataset.target;
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
                targetEl.style.display = 'flex';
            }
        });
    });

    await renderInstalledMods(name);
    await renderAddons(name, 'inst-shaders-list', 'getShaderPacks', 'toggleShaderPack', 'deleteShaderPack', 'Keine Shaders installiert.');
    await renderAddons(name, 'inst-rp-list', 'getResourcePacks', 'toggleResourcePack', 'deleteResourcePack', 'Keine Resource Packs installiert.');
    await renderScreenshots(name);
    renderInstanceSettings(name);
}

function renderInstanceSettings(name) {
    const profile = currentProfiles[name] || {};
    const ramInput = document.getElementById('inst-setting-ram');
    const ramVal = document.getElementById('inst-setting-ram-val');
    const jvmSelect = document.getElementById('inst-setting-jvm');
    const javaInput = document.getElementById('inst-setting-java');
    const saveBtn = document.getElementById('btn-inst-save-settings');

    if (ramInput && ramVal) {
        const val = profile.ram || 0;
        ramInput.value = val;
        ramVal.textContent = val > 0 ? `${val} GB` : 'Global';

        const newRamInput = ramInput.cloneNode(true);
        ramInput.parentNode.replaceChild(newRamInput, ramInput);
        newRamInput.addEventListener('input', () => {
            const v = parseInt(newRamInput.value, 10);
            ramVal.textContent = v > 0 ? `${v} GB` : 'Global';
        });
    }

    if (jvmSelect) {
        jvmSelect.value = profile.jvmPreset || 'default';
    }
    if (javaInput) {
        javaInput.value = profile.javaPath || '';
    }

    if (saveBtn) {
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', async () => {
            const currentRam = document.getElementById('inst-setting-ram');
            const currentJvm = document.getElementById('inst-setting-jvm');
            const currentJava = document.getElementById('inst-setting-java');

            if (!currentProfiles[name]) return;
            const rVal = parseInt(currentRam?.value, 10) || 0;
            if (rVal > 0) {
                currentProfiles[name].ram = rVal;
            } else {
                delete currentProfiles[name].ram;
            }

            const jVal = currentJvm?.value || 'default';
            if (jVal !== 'default') {
                currentProfiles[name].jvmPreset = jVal;
            } else {
                delete currentProfiles[name].jvmPreset;
            }

            const jPath = currentJava?.value?.trim() || '';
            if (jPath) {
                currentProfiles[name].javaPath = jPath;
            } else {
                delete currentProfiles[name].javaPath;
            }

            newSaveBtn.disabled = true;
            newSaveBtn.textContent = 'Speichere...';
            try {
                await window.electronAPI.saveProfiles(currentProfiles);
                showToast('Erfolg', `Einstellungen für ${name} gespeichert!`, 'success');
            } catch (err) {
                showToast('Fehler', 'Konnte Einstellungen nicht speichern', 'error');
            } finally {
                newSaveBtn.disabled = false;
                newSaveBtn.textContent = 'Einstellungen speichern';
            }
        });
    }
}

export async function renderAddons(profileName, listId, getIpc, toggleIpc, deleteIpc, emptyMsg) {
    const list = document.getElementById(listId);
    list.innerHTML = '<p style="padding:8px; text-align:center; color:var(--color-text-med);">Lade...</p>';
    
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
            await window.electronAPI[toggleIpc]({ profileName, filename: item.filename });
            renderAddons(profileName, listId, getIpc, toggleIpc, deleteIpc, emptyMsg);
        });
        
        div.querySelector('.del-btn').addEventListener('click', async () => {
            if (confirm(`Wirklich ${item.displayName} löschen?`)) {
                const res = await window.electronAPI[deleteIpc]({ profileName, filename: item.filename });
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

let _updateCheckCache = {};

export async function renderInstalledMods(name) {
    const list = document.getElementById('inst-mods-list');
    list.innerHTML = '<p style="padding:8px; text-align:center; color:var(--color-text-med);">Lade Mods...</p>';
    
    const mods = await window.electronAPI.getInstalledMods(name);
    list.innerHTML = '';
    
    if (mods.length === 0) {
        list.innerHTML = '<p style="padding:16px; text-align:center; color:var(--color-text-med);">Keine Mods installiert.</p>';
        return;
    }
    
    const profileData = currentProfiles[name];
    
    let updates = [];
    if (profileData) {
        const now = Date.now();
        if (!_updateCheckCache[name] || (now - _updateCheckCache[name].time > 60000)) {
            _updateCheckCache[name] = { time: now, promise: window.electronAPI.checkModUpdates({ profileName: name, loader: profileData.loader, mcVersion: profileData.version }) };
        }
        _updateCheckCache[name].promise
            .then(upd => {
                updates = upd || [];
                updates.forEach(u => {
                    const safeName = u.currentFile.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
                    const updateBtn = list.querySelector(`[data-update-file="${safeName}"]`);
                    if (updateBtn) {
                        updateBtn.style.display = 'inline-block';
                        updateBtn.title = `${u.currentVersion} → ${u.latestVersion}`;
                    }
                });
            })
            .catch(() => {});
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
                <button class="btn btn-sm update-btn" data-update-file="${mod.filename}" style="display:none; padding:6px 12px; font-size:12px; background:var(--color-success); color:#111; font-weight:700;">Update</button>
                <button class="btn btn-secondary btn-sm toggle-btn" style="padding:6px 12px; font-size:12px;">${mod.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
                <button class="btn btn-danger btn-sm del-btn" style="padding:6px 12px; font-size:12px;">Löschen</button>
            </div>
        `;
        
        item.querySelector('.update-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            const upd = updates.find(u => u.currentFile === mod.filename);
            if (!upd) return;
            btn.disabled = true;
            btn.textContent = 'Lädt...';
            const res = await window.electronAPI.updateMod({
                profileName: name,
                currentFile: upd.currentFile,
                downloadUrl: upd.downloadUrl,
                newFilename: upd.newFilename,
                newMeta: upd.newMeta
            });
            if (res.success) {
                showToast('Update', `${mod.displayName} aktualisiert!`, 'success');
                renderInstalledMods(name);
            } else {
                showToast('Fehler', res.error, 'error');
                btn.disabled = false;
                btn.textContent = 'Update';
            }
        });
        
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

async function renderScreenshots(name) {
    const list = document.getElementById('inst-gallery-list');
    list.innerHTML = '<p style="padding:16px; text-align:center; color:var(--color-text-med);">Lade Screenshots...</p>';

    let screenshots = [];
    try {
        screenshots = await window.electronAPI.getScreenshots(name);
    } catch (err) {
        console.error('Screenshot load failed:', err);
        list.innerHTML = renderEmptyScreenshotState('Fehler beim Laden der Screenshots.');
        return;
    }

    list.innerHTML = '';
    if (!screenshots || screenshots.length === 0) {
        list.innerHTML = renderEmptyScreenshotState('Keine Screenshots gefunden.');
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'screenshot-grid';
    screenshots.forEach(ss => grid.appendChild(createScreenshotItem(ss, () => renderScreenshots(name))));
    list.appendChild(grid);
}

function openDuplicateModal() {
    const modal = document.getElementById('modal-duplicate');
    const input = document.getElementById('duplicate-name-input');
    if (!modal || !input || !currentActiveInstance) return;

    closeModals();
    input.value = `${currentActiveInstance} (Kopie)`;
    modal.classList.add('active');
    window.requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(0, input.value.length);
    });
}

function closeDuplicateModal() {
    const modal = document.getElementById('modal-duplicate');
    if (!modal) return;
    modal.classList.remove('active');
}

async function confirmDuplicateInstance() {
    const input = document.getElementById('duplicate-name-input');
    const duplicateButton = document.getElementById('btn-duplicate-confirm');
    if (!input || !duplicateButton || !currentActiveInstance) return;

    const trimmedNewName = input.value?.trim();
    if (!trimmedNewName) {
        showToast('Fehler', 'Bitte gib einen Namen für die neue Instanz ein.', 'error');
        input.focus();
        return;
    }

    if (getProfilesData()[trimmedNewName]) {
        showToast('Fehler', `Ein Profil mit dem Namen "${trimmedNewName}" existiert bereits.`, 'error');
        input.focus();
        return;
    }

    duplicateButton.disabled = true;
    const originalText = duplicateButton.textContent;
    duplicateButton.textContent = 'Dupliziere...';

    try {
        const res = await window.electronAPI.duplicateProfile({ source: currentActiveInstance, newName: trimmedNewName });
        if (res.success) {
            showToast('Erfolg', `Profil wurde zu "${trimmedNewName}" dupliziert.`, 'success');
            closeDuplicateModal();
            await loadProfiles();
        } else {
            showToast('Fehler', res.error, 'error');
        }
    } finally {
        duplicateButton.disabled = false;
        duplicateButton.textContent = originalText;
    }
}

function onDomReady(fn) {
    if (document.readyState !== 'loading') {
        fn();
    } else {
        document.addEventListener('DOMContentLoaded', fn);
    }
}

// ===== WICHTIG: DOMContentLoaded wrapper damit module-level nicht crasht =====
onDomReady(() => {
    document.getElementById('btn-inst-folder')?.addEventListener('click', () => {
        if (currentActiveInstance) window.electronAPI.openProfileFolder(currentActiveInstance);
    });

    document.getElementById('btn-inst-export')?.addEventListener('click', async () => {
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

    document.getElementById('btn-inst-export-mrpack')?.addEventListener('click', async () => {
        if (currentActiveInstance) {
            showToast('Export (.mrpack)', 'Exportiere als Modrinth Pack...', 'info');
            const res = await window.electronAPI.exportMrpack({
                name: currentActiveInstance,
                packName: currentActiveInstance,
                packVersion: '1.0.0',
                packDescription: `Schleimy Launcher Export: ${currentActiveInstance}`
            });
            if (res.success) {
                showToast('Erfolg', `Profil ${currentActiveInstance} als .mrpack exportiert`, 'success');
            } else if (!res.canceled) {
                showToast('Fehler', res.error, 'error');
            }
        }
    });

    document.getElementById('btn-inst-duplicate')?.addEventListener('click', () => {
        openDuplicateModal();
    });

    document.getElementById('btn-duplicate-close')?.addEventListener('click', () => {
        closeDuplicateModal();
        const instanceModal = document.getElementById('modal-instance');
        if (instanceModal) instanceModal.classList.add('active');
    });

    document.getElementById('btn-duplicate-cancel')?.addEventListener('click', () => {
        closeDuplicateModal();
        const instanceModal = document.getElementById('modal-instance');
        if (instanceModal) instanceModal.classList.add('active');
    });

    document.getElementById('btn-duplicate-confirm')?.addEventListener('click', async () => {
        await confirmDuplicateInstance();
    });

    document.getElementById('duplicate-name-input')?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            await confirmDuplicateInstance();
        }
        if (e.key === 'Escape') {
            closeDuplicateModal();
            const instanceModal = document.getElementById('modal-instance');
            if (instanceModal) instanceModal.classList.add('active');
        }
    });

    document.getElementById('btn-inst-delete')?.addEventListener('click', async () => {
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
            
            document.getElementById('play-profile-select').value = res.newName;
            document.getElementById('play-profile-select').dispatchEvent(new Event('change'));
        } else if (!res.canceled) {
            showToast('Fehler', res.error, 'error');
        }
    });
});
