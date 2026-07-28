import { searchAll, getModVersion, resolveAllDependencies, getModDetails, getModVersions } from './api.js';
import { renderSkeletonGrid } from './ui.js';
import { showToast } from './toasts.js';

let searchTimeout = null;
let currentOffset = 0;
const LIMIT = 24;
let lastGetProfilesData = null;
let currentModDetailToken = 0; // For preventing race conditions in modal

// Simple Markdown → HTML converter for Modrinth descriptions
function markdownToHtml(md) {
    if (!md) return '';
    let html = md.replace(/\r\n/g, '\n');

    // Code blocks (```lang\n...```)

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const langClass = lang ? ` class="language-${lang}"` : '';
        return `<pre><code${langClass}>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Images ![alt](url)
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;">');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bold + italic together ***text***
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic *text*
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    // Strikethrough ~~text~~
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Horizontal rules ---
    html = html.replace(/^---\s*$/gm, '<hr>');

    // Headings
    html = html.replace(/^\s*######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^\s*#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^\s*####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^\s*###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^\s*##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^\s*#\s+(.+)$/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>');

    // Unordered list items (- or * at line start)
    html = html.replace(/^[\s]*[-*+][\s]+(.+)$/gm, '<li>$1</li>');
    // Ordered list items
    html = html.replace(/^[\s]*\d+\.[\s]+(.+)$/gm, '<li>$1</li>');

    // Wrap consecutive <li> in <ul> or <ol>
    html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Paragraphs (double newline = paragraph boundary)
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Fix block-level elements wrongly wrapped in <p>
    html = html.replace(/<p><(pre|ul|ol|blockquote|hr|h[1-6])/g, '<$1');
    html = html.replace(/<\/(pre|ul|ol|blockquote|hr|h[1-6])><\/p>/g, '</$1>');
    // Fix <p> wrapping <li> inside <ul>
    html = html.replace(/<ul><p><li>/g, '<ul><li>');
    html = html.replace(/<\/li><\/p><\/ul>/g, '</li></ul>');
    html = html.replace(/<ul><p>/g, '<ul>');
    html = html.replace(/<\/p><\/ul>/g, '</ul>');
    // Remove empty paragraphs
    html = html.replace(/<p><\/p>/g, '');

    return html;
}

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
            // Primary: match by projectId (reliable — works for CurseForge + Modrinth)
            if (m.projectId && m.projectId === slug) return true;
            // Fallback: match by filename containing slug (for legacy mods without lock entry)
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
                            const res = await window.electronAPI.updateMod({ profileName: selectedProfile, currentFile: upd.currentFile, downloadUrl: upd.downloadUrl, newFilename: upd.newFilename, newMeta: upd.newMeta });
                            if (res.success) {
                                showToast('Update', `${upd.projectName} aktualisiert!`, 'success');
                                newBtn.textContent = 'Installiert';
                            }
                        });
                    }
                });
            }
        } catch (_) { }
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
        let installedShaderpacks = [];
        let installedResourcepacks = [];
        if (selectedProfile) {
            installedMods = await window.electronAPI.getInstalledMods(selectedProfile);
            installedShaderpacks = await window.electronAPI.getShaderPacks(selectedProfile);
            installedResourcepacks = await window.electronAPI.getResourcePacks(selectedProfile);
        }
        const data = await searchAll(query, facets, LIMIT, offset, source);
        renderResults(data, getProfilesData, {
            mods: installedMods,
            shaderpacks: installedShaderpacks,
            resourcepacks: installedResourcepacks
        });
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

function renderResults(data, getProfilesData, installedItems = {}) {
    const installedMods = installedItems.mods || [];
    const installedShaderpacks = installedItems.shaderpacks || [];
    const installedResourcepacks = installedItems.resourcepacks || [];
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

        const installedList = mod.project_type === 'shader'
            ? installedShaderpacks
            : mod.project_type === 'resourcepack'
                ? installedResourcepacks
                : installedMods;
        const isInstalled = installedList.some(m => {
            if (m.projectId && m.projectId === mod.slug) return true;
            const fn = (m.filename || m).toLowerCase();
            return fn.includes(mod.slug.toLowerCase().replace('cf:', ''));
        });

        const iconUrl = mod.icon_url || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23242424"><rect width="24" height="24"/></svg>';
        const downloads = (mod.downloads / 1000000 >= 1) ? (mod.downloads / 1000000).toFixed(1) + 'M' :
            (mod.downloads / 1000 >= 1) ? (mod.downloads / 1000).toFixed(1) + 'K' : mod.downloads;

        card.innerHTML = `
            <div class="mod-card-header">
                <img src="${iconUrl}" class="mod-icon" alt="icon">
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

function switchModDetailTab(modalEl, targetId) {
    // Deactivate all tab headers, activate the matching one
    const headers = modalEl.querySelectorAll('.mod-detail-tab-header');
    headers.forEach(h => {
        h.classList.remove('active');
        if (h.dataset.target === targetId) {
            h.classList.add('active');
        }
    });

    // Show the target tab, hide all others
    const contents = modalEl.querySelectorAll('.mod-detail-tab-content');
    contents.forEach(c => {
        if (c.id === targetId) {
            // Gallery uses grid display, others use block
            c.style.display = targetId.includes('gallery') ? 'grid' : 'block';
        } else {
            c.style.display = 'none';
        }
    });
}

async function openModDetailModal(mod, _isInstalled, isCompatible, getProfilesData, origBtn, formattedDownloads) {
    const modalToken = ++currentModDetailToken; // Set a unique token for this modal opening
    const modDetailModal = document.getElementById('modal-mod-detail');
    const modDetailImg = document.getElementById('mod-detail-img');
    const modDetailType = document.getElementById('mod-detail-type');
    const modDetailTitle = document.getElementById('mod-detail-title');
    const modDetailDownloads = document.getElementById('mod-detail-downloads');
    const modDetailDate = document.getElementById('mod-detail-date');
    const btnModDetailInstall = document.getElementById('btn-mod-detail-install');
    const btnModDetailView = document.getElementById('btn-mod-detail-view');
    const modDetailDescContent = document.getElementById('mod-detail-desc-content');
    const modDetailGalleryContent = document.getElementById('mod-detail-gallery-content');
    const modDetailVersionsContent = document.getElementById('mod-detail-versions-content');

    modDetailImg.src = mod.icon_url || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23242424"><rect width="24" height="24"/></svg>';

    let typeName = 'MOD';
    if (mod.project_type === 'modpack') typeName = 'MODPACK';
    else if (mod.project_type === 'resourcepack') typeName = 'RESOURCE PACK';
    else if (mod.project_type === 'shader') typeName = 'SHADER';

    modDetailType.textContent = typeName;
    modDetailTitle.textContent = mod.title;
    modDetailDownloads.textContent = formattedDownloads;
    modDetailDate.textContent = mod.date_modified ? new Date(mod.date_modified).toLocaleDateString() : '-';

    // FRESH installed check: query the filesystem to see if this mod is installed NOW
    let isInstalled = _isInstalled;
    const selectedProfile = document.getElementById('play-profile-select').value;
    if (selectedProfile) {
        try {
            const installedMods = await window.electronAPI.getInstalledMods(selectedProfile);
            isInstalled = installedMods.some(m => {
                if (m.projectId && m.projectId === mod.slug) return true;
                const fn = (m.filename || m).toLowerCase();
                return fn.includes(mod.slug.toLowerCase().replace('cf:', ''));
            });
        } catch (_) {}
    }

    btnModDetailInstall.disabled = (isInstalled || !isCompatible);
    btnModDetailInstall.innerHTML = isInstalled
        ? '<svg viewBox="0 0 24 24" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: text-bottom; display: inline-block;"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Installiert'
        : (!isCompatible ? 'Inkompatibel' : '<svg viewBox="0 0 24 24" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: text-bottom; display: inline-block;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Installieren');

    if (origBtn.textContent === 'Update') {
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

    // Reset to first tab ("Beschreibung") BEFORE loading content
    switchModDetailTab(modDetailModal, 'mod-detail-desc-content');

    // Show loading skeleton in description
    modDetailDescContent.innerHTML = '<div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div>';
    modDetailGalleryContent.innerHTML = '<p>Lade Galerie...</p>';
    modDetailVersionsContent.innerHTML = '<p style="color:var(--color-text-med); padding: 16px; text-align:center;">Lade Versionen...</p>';

    modDetailModal.classList.add('active');

    // Start both requests in parallel, but render results progressively
    const clearToken = () => modalToken !== currentModDetailToken;

    getModDetails(mod.slug.replace('cf:', ''), mod._source, mod._cfId).then(details => {
        if (clearToken()) return;

        // --- Render Description ---
        if (details && details.body) {
            if (mod._source === 'curseforge') {
                modDetailDescContent.innerHTML = details.body;
            } else {
                modDetailDescContent.innerHTML = markdownToHtml(details.body);
            }
        } else {
            modDetailDescContent.innerHTML = 'Keine Beschreibung verfügbar.';
        }

        // --- Render Gallery ---
        if (details && details.gallery && details.gallery.length > 0) {
            modDetailGalleryContent.innerHTML = '';
            details.gallery.forEach(img => {
                const imgEl = document.createElement('img');
                imgEl.src = img.url;
                imgEl.alt = img.title;
                imgEl.className = 'gallery-image';
                modDetailGalleryContent.appendChild(imgEl);
            });
        } else {
            modDetailGalleryContent.innerHTML = '<p style="color:var(--color-text-med)">Keine Bilder in der Galerie gefunden.</p>';
        }
    }).catch(() => {
        if (!clearToken()) {
            modDetailDescContent.innerHTML = 'Fehler beim Laden der Beschreibung.';
        }
    });

    getModVersions(mod.slug.replace('cf:', ''), mod._source, mod._cfId).then(versions => {
        if (clearToken()) return;

        const profiles = getProfilesData();
        const selectedProfile = document.getElementById('play-profile-select').value;
        const profileData = selectedProfile ? profiles[selectedProfile] : null;

        if (versions && versions.length > 0) {
            modDetailVersionsContent.innerHTML = '';
            const list = document.createElement('div');
            list.className = 'addon-list';

            versions.forEach(v => {
                const item = document.createElement('div');
                item.className = 'version-item';

                const isVersionCompatible = profileData
                    ? (v.game_versions.includes(profileData.version) && v.loaders.some(l => l.toLowerCase() === profileData.loader))
                    : false;

                item.innerHTML = `
                    <div class="version-info">
                        <div class="version-name" title="${v.name}">${v.name}</div>
                        <div class="version-meta">
                            <span>📅 ${new Date(v.date).toLocaleDateString()}</span>
                        </div>
                        <div class="version-tags">
                            ${v.game_versions.slice(0, 5).map(gv => `<span class="badge">${gv}</span>`).join('')}
                            ${v.loaders.map(l => `<span class="badge loader-${l.toLowerCase()}">${l}</span>`).join('')}
                        </div>
                    </div>
                    <div class="version-actions">
                        <button class="btn btn-secondary btn-install-version" ${!profileData || !isVersionCompatible ? 'disabled' : ''}>
                            ${!profileData ? 'Profil wählen' : !isVersionCompatible ? 'Inkompatibel' : 'Installieren'}
                        </button>
                    </div>
                `;

                const installBtn = item.querySelector('.btn-install-version');
                if (profileData && isVersionCompatible) {
                    installBtn.addEventListener('click', async () => {
                        installBtn.disabled = true;
                        installBtn.textContent = 'Lädt...';

                        const primaryFile = v.files[0];
                        const modVersionData = {
                            url: primaryFile.url, filename: primaryFile.filename, dependencies: v.dependencies || [],
                            projectId: mod.slug.startsWith('cf:') ? mod.slug : v.project_id,
                            source: mod._source,
                            versionId: v.id || v.version_number,
                            versionNumber: v.version_number
                        };

                        try {
                            const downloads = await resolveAllDependencies(modVersionData, profileData.loader, profileData.version);
                            const targetDir = (mod.project_type === 'shader') ? 'shaderpacks' : (mod.project_type === 'resourcepack') ? 'resourcepacks' : 'mods';

                            for (const dl of downloads) {
                                window.electronAPI.downloadMod({
                                    downloadUrl: dl.url,
                                    fileName: dl.filename,
                                    projectId: dl.projectId,
                                    source: dl.source,
                                    versionId: dl.versionId,
                                    versionNumber: dl.versionNumber,
                                    profileName: selectedProfile,
                                    targetDir: targetDir,
                                });
                            }
                            installBtn.textContent = 'Installiert';
                            showToast('Erfolg', `${v.name} wird installiert.`, 'success');

                        } catch (e) {
                            showToast('Fehler', `Installation von ${v.name} fehlgeschlagen: ${e.message}`, 'error');
                            installBtn.disabled = false;
                            installBtn.textContent = 'Installieren';
                        }
                    });
                }
                list.appendChild(item);
            });
            modDetailVersionsContent.appendChild(list);
        } else {
            modDetailVersionsContent.innerHTML = '<p style="color:var(--color-text-med); padding: 16px; text-align:center;">Keine alternativen Versionen gefunden.</p>';
        }
    }).catch(() => {
        if (!clearToken()) {
            modDetailVersionsContent.innerHTML = '<p style="color:var(--color-text-med); padding: 16px; text-align:center;">Fehler beim Laden der Versionen.</p>';
        }
    });

    // Install Button Handler — call handleInstallClick with the modal button as trigger
    // so setAllInstallButtons can track which mod the modal shows
    btnModDetailInstall.dataset.modalSlug = mod.slug;
    btnModDetailInstall.onclick = () => {
        handleInstallClick(mod.slug, mod.project_type, getProfilesData, btnModDetailInstall);
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

    // Set all matching buttons to loading state
    setAllInstallButtons(slug, btnElement, { text: 'Lädt...', disabled: true });

    const profile = profiles[selectedProfile];
    showToast('Abhängigkeiten auflösen', `Suche kompatible Version von ${slug}...`, 'info');

    try {
        const vInfo = await getModVersion(slug, profile.loader, profile.version);
        // vInfo contains all necessary metadata from the new getModVersion in main.js
        const downloads = await resolveAllDependencies(vInfo, profile.loader, profile.version);

        if (downloads.length > 1) {
            showToast('Abhängigkeiten', `${downloads.length - 1} weitere Abhängigkeiten werden installiert.`, 'info');
        }

        const targetDir = (projectType === 'shader') ? 'shaderpacks' : (projectType === 'resourcepack') ? 'resourcepacks' : 'mods';

        for (const dl of downloads) {
            window.electronAPI.downloadMod({
                downloadUrl: dl.url,
                fileName: dl.filename,
                projectId: dl.projectId,
                source: dl.source,
                versionId: dl.versionId,
                versionNumber: dl.versionNumber,
                profileName: selectedProfile,
                targetDir: targetDir,
            });
        }

        // Immediately mark as installed — download runs async in background
        // If it fails, the error toast in app.js will inform the user.
        // refreshInstallStates() will re-check actual files on disk when
        // switching to the discover tab next time.
        setAllInstallButtons(slug, btnElement, { text: 'Installiert', disabled: true });
    } catch (e) {
        showToast('Installationsfehler', e.message, 'error');
        setAllInstallButtons(slug, btnElement, { text: 'Installieren', disabled: false });
    }
}

// Helper: update ALL buttons (card + modal) for a given mod slug
function setAllInstallButtons(slug, triggerBtn, { text, disabled }) {
    // 1. Card button in the discover grid
    const cardBtn = document.querySelector(`#discover-grid .btn-install[data-slug="${slug}"]`);
    if (cardBtn) {
        cardBtn.textContent = text;
        cardBtn.disabled = disabled;
    }

    // 2. Modal install button, but only if it's showing the same mod
    const btnModal = document.getElementById('btn-mod-detail-install');
    if (btnModal) {
        const modalSlug = btnModal.dataset.modalSlug;
        if (modalSlug === slug) {
            btnModal.textContent = text;
            btnModal.disabled = disabled;
            btnModal.style.backgroundColor = '';
            btnModal.style.borderColor = '';
        }
    }

    // Store slug on modal button on first call so we can match later
    if (triggerBtn && triggerBtn.id === 'btn-mod-detail-install') {
        triggerBtn.dataset.modalSlug = slug;
    }
}

// Tab switching via event delegation on the mod detail modal
document.addEventListener('click', (e) => {
    const header = e.target.closest('.mod-detail-tab-header');
    if (!header) return;
    const modal = header.closest('.modal-overlay');
    if (!modal || !modal.classList.contains('active')) return;
    const targetId = header.dataset.target;
    if (!targetId) return;
    switchModDetailTab(modal, targetId);
});

// Listen for download success/error events to update install buttons accordingly
window.electronAPI.onLauncherEvent((evt) => {
    if (!evt.data?.fileName) return;
    
    const fileName = evt.data.fileName.toLowerCase().replace(/\.jar$/, '');
    const isSuccess = evt.type === 'success';
    const text = isSuccess ? 'Installiert' : 'Installieren';
    const projectId = evt.data.projectId || null;
    
    // 1. Card buttons — iterate all to find matching slug
    document.querySelectorAll('#discover-grid .btn-install[data-slug]').forEach(btn => {
        const slug = btn.dataset.slug;
        // Try projectId match first (reliable)
        if (projectId && projectId === slug) {
            btn.textContent = text;
            btn.disabled = isSuccess;
            return;
        }
        // Fallback: filename matching (for backward compatibility)
        if (fileName.includes(slug.toLowerCase()) || slug.toLowerCase().includes(fileName)) {
            btn.textContent = text;
            btn.disabled = isSuccess;
        }
    });
    
    // 2. Modal button
    const btnModal = document.getElementById('btn-mod-detail-install');
    if (btnModal && btnModal.dataset.modalSlug) {
        const modalSlug = btnModal.dataset.modalSlug;
        // Try projectId match first (reliable)
        if (projectId && projectId === modalSlug) {
            btnModal.textContent = text;
            btnModal.disabled = isSuccess;
            btnModal.style.backgroundColor = '';
            btnModal.style.borderColor = '';
            return;
        }
        // Fallback: filename matching
        if (fileName.includes(modalSlug.toLowerCase()) || modalSlug.includes(fileName)) {
            btnModal.textContent = text;
            btnModal.disabled = isSuccess;
            btnModal.style.backgroundColor = '';
            btnModal.style.borderColor = '';
        }
    }
});
