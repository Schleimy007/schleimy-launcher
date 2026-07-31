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
export function updateAllVersionSelects(versions) {
    if (!Array.isArray(versions) || versions.length === 0) return;
    const createSel = document.getElementById('create-version');
    const filterSel = document.getElementById('filter-version');
    const wizardSel = document.getElementById('wizard-version');

    const releases = versions.filter(v => v.type === 'release');
    const snapshots = versions.filter(v => v.type !== 'release');

    let createHtml = '';
    let filterHtml = '<option value="">Alle Versionen</option>';
    let wizardHtml = '';

    if (releases.length > 0) {
        createHtml += '<optgroup label="Releases (Empfohlen)">';
        filterHtml += '<optgroup label="Releases (Empfohlen)">';
        wizardHtml += '<optgroup label="Releases (Empfohlen)">';
        releases.forEach(v => {
            createHtml += `<option value="${v.id}">${v.id}</option>`;
            filterHtml += `<option value="${v.id}">${v.id}</option>`;
            wizardHtml += `<option value="${v.id}">${v.id}</option>`;
        });
        createHtml += '</optgroup>';
        filterHtml += '</optgroup>';
        wizardHtml += '</optgroup>';
    }

    if (snapshots.length > 0) {
        createHtml += '<optgroup label="Snapshots / Beta">';
        filterHtml += '<optgroup label="Snapshots / Beta">';
        wizardHtml += '<optgroup label="Snapshots / Beta">';
        snapshots.forEach(v => {
            createHtml += `<option value="${v.id}">${v.id}</option>`;
            filterHtml += `<option value="${v.id}">${v.id}</option>`;
            wizardHtml += `<option value="${v.id}">${v.id}</option>`;
        });
        createHtml += '</optgroup>';
        filterHtml += '</optgroup>';
        wizardHtml += '</optgroup>';
    }

    if (createSel) createSel.innerHTML = createHtml;
    if (filterSel) filterSel.innerHTML = filterHtml;
    if (wizardSel) wizardSel.innerHTML = wizardHtml;
}

export async function fetchMojangVersions() {
    const CACHE_KEY = 'mojang_versions_cache';
    const TIME_KEY = 'mojang_versions_timestamp';
    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 Stunden in Millisekunden

    const FALLBACK_VERSIONS = [
        "1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21", "1.20.6", "1.20.5", "1.20.4", "1.20.3", "1.20.2", "1.20.1", "1.20",
        "1.19.4", "1.19.3", "1.19.2", "1.19.1", "1.19", "1.18.2", "1.18.1", "1.18",
        "1.17.1", "1.17", "1.16.5", "1.16.4", "1.16.3", "1.16.2", "1.16.1", "1.16",
        "1.15.2", "1.14.4", "1.12.2", "1.8.9"
    ].map(id => ({ id, type: 'release' })).concat([
        { id: "24w46a", type: "snapshot" },
        { id: "24w33a", type: "snapshot" },
        { id: "23w51b", type: "snapshot" }
    ]);

    const cached = localStorage.getItem(CACHE_KEY);
    const timestamp = localStorage.getItem(TIME_KEY);

    if (cached && timestamp && (Date.now() - parseInt(timestamp) < CACHE_DURATION)) {
        try {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
                updateAllVersionSelects(parsed);
                return parsed;
            }
        } catch (_) {}
    }

    // Always set fallback immediately so UI is never empty
    updateAllVersionSelects(FALLBACK_VERSIONS);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json', { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('Netzwerkfehler beim Laden der Versionen');
        const data = await res.json();

        localStorage.setItem(CACHE_KEY, JSON.stringify(data.versions));
        localStorage.setItem(TIME_KEY, Date.now().toString());

        updateAllVersionSelects(data.versions);
        return data.versions;
    } catch (e) {
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    updateAllVersionSelects(parsed);
                    return parsed;
                }
            } catch (_) {}
        }
        updateAllVersionSelects(FALLBACK_VERSIONS);
        return FALLBACK_VERSIONS;
    }
}
