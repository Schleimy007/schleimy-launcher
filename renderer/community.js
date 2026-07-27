import { showToast } from './toasts.js';
import { createProfile, loadProfiles, getProfilesData } from './profiles.js';

let publicServers = [];

export function initCommunityTab() {
    const btnRefresh = document.getElementById('btn-community-refresh');
    const btnJoin = document.getElementById('btn-community-join');
    const joinInput = document.getElementById('community-join-code');
    
    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => refreshPublicServers());
    }
    
    if (btnJoin) {
        btnJoin.addEventListener('click', async () => {
            const code = joinInput.value.trim().toUpperCase();
            if (code.length < 6) {
                showToast('Fehler', 'Bitte einen gültigen 6-stelligen Code eingeben.', 'error');
                return;
            }
            btnJoin.disabled = true;
            btnJoin.textContent = 'Verbinde...';
            await joinServer(code);
            btnJoin.disabled = false;
            btnJoin.textContent = 'Beitreten';
        });
    }
    
    // Auto-refresh when switching to this tab
    document.querySelector('[data-tab="community"]').addEventListener('click', () => {
        refreshPublicServers();
    });
    // Listen for dynamically found servers
    window.addEventListener('public-server-found', (e) => {
        const server = e.detail;
        if (!publicServers.find(s => s.code === server.code)) {
            publicServers.push(server);
            renderPublicServer(server);
        }
    });
}



async function refreshPublicServers() {
    const list = document.getElementById('community-servers-list');
    list.innerHTML = '<div class="empty-state" style="color:var(--color-text-med); text-align:center; padding: 24px;">Suche Server im P2P-Netzwerk... (kann bis zu 15s dauern)</div>';
    
    publicServers = [];
    
    // Will dynamically append via renderPublicServer as they arrive
    await window.electronAPI.p2pFetchPublic();
    
    if (publicServers.length === 0) {
        list.innerHTML = '<div class="empty-state">Keine öffentlichen Welten gefunden.</div>';
    } else {
        const emptyState = list.querySelector('.empty-state');
        if (emptyState) emptyState.remove();
    }
}

function renderPublicServer(server) {
    const list = document.getElementById('community-servers-list');
    const emptyState = list.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const card = document.createElement('div');
    card.className = 'card';
    card.style.display = 'flex';
    card.style.justifyContent = 'space-between';
    card.style.alignItems = 'center';
    
    const modText = server.mods && server.mods.length > 0 ? `${server.mods.length} Mods` : 'Vanilla';
    
    card.innerHTML = `
        <div>
            <h3 style="margin:0 0 4px 0;">${server.name}</h3>
            <div class="mod-meta">
                <span class="badge" style="background:var(--color-bg-dark);">${server.host}</span>
                <span class="badge">${server.mcVersion}</span>
                <span class="badge">${server.loader}</span>
                <span class="badge">${modText}</span>
            </div>
        </div>
        <button class="btn btn-primary btn-join-public" data-code="${server.code}">Beitreten</button>
    `;
    
    card.querySelector('.btn-join-public').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Verbinde...';
        await joinServer(server.code, server);
        btn.disabled = false;
        btn.textContent = 'Beitreten';
    });
    
    list.appendChild(card);
}

async function joinServer(code, preloadedInfo = null) {
    showToast('Info', 'Verbinde zum Host...', 'info');
    
    let info = preloadedInfo;
    if (!info) {
        info = await window.electronAPI.p2pGetInfo(code);
    }
    
    if (!info) {
        showToast('Fehler', 'Host antwortet nicht oder Code falsch.', 'error');
        return;
    }
    
    showToast('Erfolg', 'Host gefunden! Baue P2P Tunnel auf...', 'success');
    
    const joinRes = await window.electronAPI.p2pJoin(code);
    if (!joinRes.success) {
        showToast('Fehler', joinRes.error, 'error');
        return;
    }
    
    showToast('Erfolg', 'Tunnel aufgebaut! Bereite Spiel vor...', 'success');
    
    // Auto Mod Installer / Profile creation
    const profileName = `Hosted - ${info.host}`.replace(/[^a-zA-Z0-9 -]/g, '');
    const profiles = getProfilesData();
    
    // Create new profile if it doesn't exist
    if (!profiles[profileName]) {
        await createProfile(profileName, info.loader, info.mcVersion, 'none');
        // Install mods...
        if (info.mods && info.mods.length > 0) {
            showToast('Info', `Installiere ${info.mods.length} Mods...`, 'info');
            for (const mod of info.mods) {
                try {
                    // mod.hash contains the SHA1 hash of the jar
                    const res = await fetch(`https://api.modrinth.com/v2/version_file/${mod.hash}?algorithm=sha1`);
                    if (res.ok) {
                        const vData = await res.json();
                        const downloadUrl = vData.files.find(f => f.primary)?.url || vData.files[0].url;
                        if (downloadUrl) {
                            await window.electronAPI.updateMod({
                                profileName,
                                currentFile: '',
                                newFilename: mod.filename,
                                downloadUrl: downloadUrl
                            });
                        }
                    } else {
                        console.warn('Modrinth API returned error for hash', mod.hash);
                    }
                } catch(e) {
                    console.error('Failed to resolve mod hash', e);
                }
            }
        }
    }
    
    // Launch the game with auto-connect
    window.electronAPI.startGame({
        profileName: profileName,
        version: info.mcVersion,
        loader: info.loader,
        isJoin: true // Tells main.js to add --server 127.0.0.1 --port 25565
    });
}
