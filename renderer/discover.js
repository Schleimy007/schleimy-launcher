import { searchAll, searchModrinth, getModVersion, resolveAllDependencies } from './api.js';
import { renderSkeletonGrid } from './ui.js';
import { showToast } from './toasts.js';

let searchTimeout = null;
let currentOffset = 0;
const LIMIT = 24;
let lastGetProfilesData = null;

export function initDiscover(getProfilesData) {
    lastGetProfilesData = getProfilesData;
    const searchInput = document.getElementById('search-input');
    const searchType = document.getElementById('search-type');
    const filterVersion = document.getElementById('filter-version');
    const filterLoader = document.getElementById('filter-loader');
    const filterCategory = document.getElementById('filter-category');

    const triggerSearch = () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => performSearch(0, getProfilesData), 400);
    };

    searchInput.addEventListener('input', triggerSearch);
    searchType.addEventListener('change', triggerSearch);
    filterVersion.addEventListener('change', triggerSearch);
    filterLoader.addEventListener('change', triggerSearch);
    filterCategory.addEventListener('change', triggerSearch);
    
    const searchSource = document.getElementById('search-source');
    if (searchSource) searchSource.addEventListener('change', triggerSearch);
    
    // Refresh search results when profile changes to update compatibility hints
    const playSelect = document.getElementById('play-profile-select');
    if (playSelect) {
        playSelect.addEventListener('change', triggerSearch);
    }

    // Refresh install states when switching to the discover tab
    document.querySelector('[data-tab="discover"]')?.addEventListener('click', () => {
        refreshInstallStates();
    });
}

async function refreshInstallStates() {
    const selectedProfile = document.getElementById('play-profile-select').value;
    if (!selectedProfile) return;
    
    const installedMods = await window.electronAPI.getInstalledMods(selectedProfile);
    const profiles = lastGetProfilesData ? lastGetProfilesData() : {};
    const profileData = profiles[selectedProfile];
    const buttons = document.querySelectorAll('#discover-grid .btn-install');
    
    buttons.forEach(btn => {
        const slug = btn.dataset.slug;
        if (!slug) return;
        // Skip buttons that show 'Inkompatibel' or 'Lädt...'
        if (btn.textContent.trim() === 'Inkompatibel' || btn.textContent.trim() === 'Lädt...') return;
        
        const isInstalled = installedMods.some(m => {
            const fn = (m.filename || m).toLowerCase();
            return fn.includes(slug.toLowerCase());
        });
        
        if (isInstalled) {
            btn.textContent = 'Installiert';
            btn.disabled = true;
        } else {
            // File no longer exists -> allow re-install
            btn.textContent = 'Installieren';
            btn.disabled = false;
        }
    });
    
    // Check for updates on installed mods and turn 'Installiert' into green 'Update' buttons
    if (profileData) {
        try {
            const updates = await window.electronAPI.checkModUpdates({ profileName: selectedProfile, loader: profileData.loader, mcVersion: profileData.version });
            if (updates && updates.length > 0) {
                buttons.forEach(btn => {
                    const slug = btn.dataset.slug;
                    if (!slug || btn.textContent.trim() !== 'Installiert') return;
                    
                    const hasUpdate = updates.some(u => {
                        const pName = (u.projectName || '').toLowerCase();
                        return pName.includes(slug.toLowerCase()) || slug.toLowerCase().includes(pName.replace(/ /g, '-'));
                    });
                    
                    if (hasUpdate) {
                        const upd = updates.find(u => {
                            const pName = (u.projectName || '').toLowerCase();
                            return pName.includes(slug.toLowerCase()) || slug.toLowerCase().includes(pName.replace(/ /g, '-'));
                        });
                        btn.textContent = 'Update';
                        btn.disabled = false;
                        btn.style.background = 'var(--color-success)';
                        btn.style.color = '#111';
                        btn.style.fontWeight = '700';
                        btn.title = `${upd.currentVersion} → ${upd.latestVersion}`;
                        // Replace click handler for update
                        const newBtn = btn.cloneNode(true);
                        btn.parentNode.replaceChild(newBtn, btn);
                        newBtn.addEventListener('click', async () => {
                            newBtn.disabled = true;
                            newBtn.textContent = 'Lädt...';
                            const res = await window.electronAPI.updateMod({ profileName: selectedProfile, currentFile: upd.currentFile, downloadUrl: upd.downloadUrl, newFilename: upd.newFilename });
                            if (res.success) {
                                showToast('Update', `${upd.projectName} aktualisiert!`, 'success');
                                newBtn.textContent = 'Installiert';
                        btn.textContent = 'Update';
                    }
                });
            } catch (_) {}
        }
    }
}

async function performSearch(offset, getProfilesData) {
    currentOffset = offset;
    lastGetProfilesData = getProfilesData;
    const query = document.getElementById('search-input').value.trim();
    const grid = document.getElementById('discover-grid');
    const pagination = document.getElementById('discover-pagination');
    
    const facets = {
        type: document.getElementById('search-type').value,
        version: document.getElementById('filter-version').value,
        loader: document.getElementById('filter-loader').value,
        category: document.getElementById('filter-category').value
    };

    renderSkeletonGrid('discover-grid', 12);
    pagination.innerHTML = '';

    try {
        const source = document.getElementById('search-source')?.value || 'all';
        const selectedProfile = document.getElementById('play-profile-select').value;
        let installedMods = [];
        if (selectedProfile) {
            installedMods = await window.electronAPI.getInstalledMods(selectedProfile);
        }
        const data = await searchAll(query, facets, LIMIT, offset, source);
        renderResults(data, getProfilesData, installedMods);
    } catch (e) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <svg class="empty-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="none" stroke="currentColor" stroke-width="2"/></svg>
                <h3 style="color:var(--color-text-high);">Fehler bei der Suche</h3>
                <p>${e.message}</p>
                <button class="btn btn-primary" style="margin-top:16px;" onclick="document.getElementById('search-input').dispatchEvent(new Event('input'))">Erneut versuchen</button>
            </div>
        `;
    }
}

function renderResults(data, getProfilesData, installedMods = []) {
    const grid = document.getElementById('discover-grid');
    grid.innerHTML = '';

    if (data.hits.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <svg class="empty-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <h3 style="color:var(--color-text-high);">Keine Treffer gefunden</h3>
                <p>Versuche andere Suchbegriffe oder lockere deine Filter.</p>
            </div>
        `;
        return;
    }

    // Get current selected profile for compatibility hints
    const selectedProfile = document.getElementById('play-profile-select').value;
    const profiles = getProfilesData();
    const profileData = selectedProfile ? profiles[selectedProfile] : null;

    data.hits.forEach((mod, index) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.animationDelay = `${(index % LIMIT) * 20}ms`;
        card.style.cursor = 'pointer';

        // Check compatibility
        let isCompatible = true;
        let compatHint = '';
        if (profileData) {
            if (mod.project_type === 'shader' || mod.project_type === 'resourcepack') {
                isCompatible = true;
            } else {
                if (!mod.versions.includes(profileData.version)) isCompatible = false;
                if (!mod.categories.includes(profileData.loader)) isCompatible = false;
            }
            
            compatHint = isCompatible 
                ? `<span style="color:var(--color-success); font-size:12px; display:flex; align-items:center; gap:4px;"><svg style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M20 6L9 17l-5-5"/></svg> Kompatibel</span>`
                : `<span style="color:var(--color-danger); font-size:12px; display:flex; align-items:center; gap:4px;"><svg style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M12 2L2 22h20L12 2zm1 16h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg> Inkompatibel</span>`;
        } else {
            compatHint = `<span style="color:var(--color-text-med); font-size:12px;">Kein Profil gewählt</span>`;
        }

        const isInstalled = installedMods.some(m => {
            const fn = (m.filename || m).toLowerCase();
            return fn.includes(mod.slug.toLowerCase().replace('cf:', ''));
        });

        const iconUrl = mod.icon_url || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23242424"><rect width="24" height="24"/></svg>';
        const downloads = (mod.downloads / 1000000 >= 1) ? (mod.downloads / 1000000).toFixed(1) + 'M' : 
                          (mod.downloads / 1000 >= 1) ? (mod.downloads / 1000).toFixed(1) + 'K' : mod.downloads;

        card.innerHTML = `
            <div class="mod-card-header">
                <img src="${iconUrl}" class="mod-icon" alt="icon" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;%23242424&quot;><rect width=&quot;24&quot; height=&quot;24&quot;/></svg>'">
                <div class="mod-title-area">
                    <div class="mod-title" title="${mod.title}">${mod.title}</div>
                    <div class="mod-author">by ${mod.author}</div>
                </div>
            </div>
            <div class="mod-desc">${mod.description}</div>
            
            <div class="mod-meta">
                <span class="badge" style="display:flex; align-items:center; gap:4px;">
                    <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    ${downloads}
                </span>
                ${mod._source === 'curseforge' ? '<span class="badge" style="background:#F16436;color:white;">CF</span>' : '<span class="badge" style="background:#1bd96a;color:#111;">MR</span>'}
                ${mod.categories.includes('fabric') ? '<span class="badge loader-fabric">Fabric</span>' : ''}
                ${mod.categories.includes('forge') ? '<span class="badge loader-forge">Forge</span>' : ''}
                ${mod.categories.includes('neoforge') ? '<span class="badge loader-forge">NeoForge</span>' : ''}
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:auto;">
                ${compatHint}
                <button class="btn btn-secondary btn-install" data-slug="${mod.slug}" ${(isInstalled || (profileData && !isCompatible)) ? 'disabled' : ''}>
                    ${isInstalled ? 'Installiert' : (profileData && !isCompatible ? 'Inkompatibel' : 'Installieren')}
                </button>
            </div>
        `;

        const btn = card.querySelector('.btn-install');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleInstallClick(mod.slug, mod.project_type, getProfilesData, btn);
        });

        card.addEventListener('click', () => {
            openModDetailModal(mod, isInstalled, !profileData || isCompatible, getProfilesData, btn, downloads);
        });

        grid.appendChild(card);
    });

    renderPagination(data.total_hits, getProfilesData);
}

async function openModDetailModal(mod, isInstalled, isCompatible, getProfilesData, origBtn, formattedDownloads) {
    modDetailImg.src = mod.icon_url || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23242424"><rect width="24" height="24"/></svg>';
    
    let typeName = 'MOD';
    if(mod.project_type === 'modpack') typeName = 'MODPACK';
    else if(mod.project_type === 'resourcepack') typeName = 'RESOURCE PACK';
    else if(mod.project_type === 'shader') typeName = 'SHADER';
    
    modDetailType.textContent = typeName;
    modDetailTitle.textContent = mod.title;
    modDetailDownloads.textContent = formattedDownloads;
    modDetailDate.textContent = mod.date_modified ? new Date(mod.date_modified).toLocaleDateString() : '-';
    
    btnModDetailInstall.disabled = (isInstalled || !isCompatible);
    btnModDetailInstall.innerHTML = isInstalled 
        ? '<svg viewBox="0 0 24 24" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: text-bottom; display: inline-block;"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Installiert'
        : (!isCompatible ? 'Inkompatibel' : '<svg viewBox="0 0 24 24" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: text-bottom; display: inline-block;"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Installieren');

    if(origBtn.textContent === 'Update') {
        btnModDetailInstall.disabled = false;
        btnModDetailInstall.textContent = 'Update';
        btnModDetailInstall.style.backgroundColor = '#10B981';
        btnModDetailInstall.style.borderColor = '#10B981';
    } else {
        btnModDetailInstall.style.backgroundColor = '';
        btnModDetailInstall.style.borderColor = '';
    }

    const browserUrl = mod._source === 'curseforge' 
        ? `https://www.curseforge.com/minecraft/mc-mods/${mod._cfId}` 
        : `https://modrinth.com/${mod.project_type}/${mod.slug}`;
    
    btnModDetailView.href = browserUrl;

    // Load Description
    modDetailDesc.innerHTML = '<div class="skeleton" style="height:20px; width:60%; margin-bottom:10px;"></div><div class="skeleton" style="height:20px; width:40%;"></div>';
    
    modDetailModal.classList.add('active');

    const desc = await getModDescription(mod.slug.replace('cf:', ''), mod._source, mod._cfId);
    
    // Parse Markdown (very basic)
    const mdToHtml = (md) => {
        if(!md) return '';
        let html = md;
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');
        html = html.replace(/\*\*(.*)\*\*/gim, '<b>$1</b>');
        html = html.replace(/\*(.*)\*/gim, '<i>$1</i>');
        html = html.replace(/!\[(.*?)\]\((.*?)\)/gim, "<img alt='$1' src='$2' />");
        html = html.replace(/\[(.*?)\]\((.*?)\)/gim, "<a href='$2'>$1</a>");
        html = html.replace(/\n$/gim, '<br />');
        return html;
    };
    
    // If it looks like HTML, don't parse as markdown
    if(desc.includes('<p>') || desc.includes('<h1>') || desc.includes('<div>')) {
        modDetailDesc.innerHTML = desc;
    } else {
        modDetailDesc.innerHTML = mdToHtml(desc);
    }

    // Install Button Handler
    btnModDetailInstall.onclick = () => {
        handleInstallClick(mod.slug, mod.project_type, getProfilesData, origBtn);
        btnModDetailInstall.innerHTML = '<svg viewBox="0 0 24 24" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: text-bottom; display: inline-block; animation: spin 1s linear infinite;"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Lädt...';
        btnModDetailInstall.disabled = true;
    };
}

function renderPagination(totalHits, getProfilesData) {
    const pagination = document.getElementById('discover-pagination');
    pagination.innerHTML = '';
    
    if (totalHits <= LIMIT) return;

    const totalPages = Math.ceil(totalHits / LIMIT);
    const currentPage = Math.floor(currentOffset / LIMIT) + 1;

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn btn-secondary';
    prevBtn.textContent = 'Zurück';
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => performSearch(currentOffset - LIMIT, getProfilesData);
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-secondary';
    nextBtn.textContent = 'Weiter';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => performSearch(currentOffset + LIMIT, getProfilesData);

    const info = document.createElement('span');
    info.style.alignSelf = 'center';
    info.style.color = 'var(--color-text-med)';
    info.style.fontSize = '14px';
    info.textContent = `Seite ${currentPage} von ${totalPages}`;

    pagination.appendChild(prevBtn);
    pagination.appendChild(info);
    pagination.appendChild(nextBtn);
}

async function handleInstallClick(slug, projectType, getProfilesData, btnElement) {
    const selectedProfile = document.getElementById('play-profile-select').value;
    const profiles = getProfilesData();
    
    if (!selectedProfile) {
        showToast('Fehler', 'Bitte wähle unten zuerst ein Profil aus, in das installiert werden soll.', 'error');
        return;
    }
    
    if (btnElement) {
        btnElement.disabled = true;
        btnElement.textContent = 'Lädt...';
    }

    const profile = profiles[selectedProfile];
    showToast('Abhängigkeiten auflösen', `Suche kompatible Version von ${slug}...`, 'info');

    try {
        const vInfo = await getModVersion(slug, profile.loader, profile.version);
        const downloads = await resolveAllDependencies(vInfo, profile.loader, profile.version);
        
        if (downloads.length > 1) {
            showToast('Abhängigkeiten', `${downloads.length - 1} weitere Abhängigkeiten werden installiert.`, 'info');
        }
        
        let targetDir = 'mods';
        if (projectType === 'shader') targetDir = 'shaderpacks';
        else if (projectType === 'resourcepack') targetDir = 'resourcepacks';

        for (const dl of downloads) {
            window.electronAPI.downloadMod({
                downloadUrl: dl.url,
                profileName: selectedProfile,
                fileName: dl.filename,
                targetDir: targetDir
            });
        }
        
        if (btnElement) {
            btnElement.textContent = 'Installiert';
        }
        
        // After a short delay, verify the file actually landed on disk
        setTimeout(async () => {
            const installedMods = await window.electronAPI.getInstalledMods(selectedProfile);
            const isNowInstalled = installedMods.some(m => {
                const fn = (m.filename || m).toLowerCase();
                return fn.includes(slug.toLowerCase());
            });
            if (btnElement) {
                if (isNowInstalled) {
                    btnElement.textContent = 'Installiert';
                    btnElement.disabled = true;
                } else {
                    btnElement.textContent = 'Installieren';
                    btnElement.disabled = false;
                }
            }
        }, 3000);
    } catch (e) {
        showToast('Installationsfehler', e.message, 'error');
        if (btnElement) {
            btnElement.disabled = false;
            btnElement.textContent = 'Installieren';
        }
    }
}
