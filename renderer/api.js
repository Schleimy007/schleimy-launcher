// API interactions (Modrinth, CurseForge & Mojang)
// All heavy lifting is now done in main.js to centralize API access and keys.

import { showToast } from './toasts.js';

export async function searchAll(query, facets, limit = 20, offset = 0, source = 'all') {
    try {
        return await window.electronAPI.searchAll({ query, facets, limit, offset, source });
    } catch (e) {
        console.error("searchAll IPC error:", e);
        showToast('API Fehler', e.message, 'error');
        return { hits: [], total_hits: 0 };
    }
}

export async function getModVersion(slug, loader, mcVersion) {
    try {
        return await window.electronAPI.getModVersion({ slug, loader, mcVersion });
    } catch (e) {
        console.error("getModVersion IPC error:", e);
        throw e;
    }
}

export async function resolveAllDependencies(modVersionData, loader, mcVersion) {
    try {
        return await window.electronAPI.resolveAllDependencies({ modVersionData, loader, mcVersion });
    } catch (e) {
        console.error("resolveAllDependencies IPC error:", e);
        throw e;
    }
}

export async function getModDetails(slug, source, cfId) {
    try {
        return await window.electronAPI.getModDetails({ slug, source, cfId });
    } catch (e) {
        console.error("getModDetails IPC error:", e);
        return null;
    }
}

export async function getModVersions(slug, source, cfId) {
    try {
        return await window.electronAPI.getModVersions({ slug, source, cfId });
    } catch (e) {
        console.error("getModVersions IPC error:", e);
        return [];
    }
}

// Mojang API can still be called from renderer as it's simple and public
export async function fetchMojangVersions() {
    const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    if (!res.ok) throw new Error('Netzwerkfehler beim Laden der Versionen');
    return (await res.json()).versions;
}
