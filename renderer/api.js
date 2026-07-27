// API interactions (Modrinth, CurseForge & Mojang)

const MODRINTH_API = 'https://api.modrinth.com/v2';

// ===== CURSEFORGE API =====
const CF_API = 'https://api.curseforge.com/v1';
const CF_API_KEY = '$2a$10$JGxLNnSP/xV2xHkCcVTf8ekyd11IQl4/iHhW7e4wgR7WrTODM4S3y';
const CF_GAME_ID = 432; // Minecraft

// CurseForge class IDs
const CF_CLASS = {
    mod: 6,
    modpack: 4471,
    resourcepack: 12,
    shader: 6552,
};

// CurseForge loader type IDs
const CF_LOADER = {
    forge: 1,
    fabric: 4,
    neoforge: 6,
    quilt: 5,
};

export async function searchCurseForge(query, facets, limit = 20, offset = 0) {
    try {
        const url = new URL(`${CF_API}/mods/search`);
        url.searchParams.append('gameId', CF_GAME_ID);
        url.searchParams.append('searchFilter', query);
        url.searchParams.append('pageSize', limit);
        url.searchParams.append('index', offset);
        url.searchParams.append('sortField', 2); // Popularity
        url.searchParams.append('sortOrder', 'desc');

        if (facets.type && CF_CLASS[facets.type]) {
            url.searchParams.append('classId', CF_CLASS[facets.type]);
        }
        if (facets.loader && CF_LOADER[facets.loader]) {
            url.searchParams.append('modLoaderType', CF_LOADER[facets.loader]);
        }
        if (facets.version) {
            url.searchParams.append('gameVersion', facets.version);
        }

        const res = await fetch(url, {
            headers: { 'x-api-key': CF_API_KEY, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error('Fehler bei der CurseForge-Suche');
        const data = await res.json();

        // Normalize to same format as Modrinth
        const hits = data.data.map(mod => ({
            slug: `cf:${mod.id}`,
            title: mod.name,
            description: mod.summary,
            author: mod.authors?.[0]?.name || 'Unbekannt',
            icon_url: mod.logo?.thumbnailUrl || '',
            downloads: mod.downloadCount,
            versions: mod.latestFilesIndexes?.map(f => f.gameVersion) || [],
            categories: mod.latestFilesIndexes?.map(f => {
                const lt = f.modLoader;
                if (lt === 1) return 'forge';
                if (lt === 4) return 'fabric';
                if (lt === 6) return 'neoforge';
                if (lt === 5) return 'quilt';
                return '';
            }).filter(Boolean) || [],
            project_type: Object.entries(CF_CLASS).find(([, v]) => v === mod.classId)?.[0] || 'mod',
            _source: 'curseforge',
            _cfId: mod.id,
        }));

        return {
            hits,
            total_hits: data.pagination?.totalCount || hits.length,
        };
    } catch (e) {
        console.error('CurseForge search error:', e);
        throw e;
    }
}

export async function getCurseForgeModVersion(cfId, loader, mcVersion) {
    try {
        const url = new URL(`${CF_API}/mods/${cfId}/files`);
        if (mcVersion) url.searchParams.append('gameVersion', mcVersion);
        if (loader && CF_LOADER[loader]) url.searchParams.append('modLoaderType', CF_LOADER[loader]);
        url.searchParams.append('pageSize', 1);

        const res = await fetch(url, {
            headers: { 'x-api-key': CF_API_KEY, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error('Fehler beim Abrufen der CurseForge-Version');
        const data = await res.json();

        if (!data.data || data.data.length === 0) {
            throw new Error(`Keine kompatible CurseForge-Version für ${loader} ${mcVersion} gefunden.`);
        }

        const file = data.data[0];
        return {
            url: file.downloadUrl,
            filename: file.fileName,
            dependencies: (file.dependencies || []).filter(d => d.relationType === 3).map(d => ({
                dependency_type: 'required',
                project_id: `cf:${d.modId}`,
                _cfId: d.modId,
            })),
        };
    } catch (e) {
        console.error('CurseForge version error:', e);
        throw e;
    }
}

// ===== COMBINED SEARCH (Modrinth + CurseForge) =====
export async function searchAll(query, facets, limit = 20, offset = 0, source = 'all') {
    // If it's a Vanilla profile, we don't allow Mods. We ONLY allow resource packs and shaders.
    if (facets.loader === 'vanilla' && (!facets.type || facets.type === 'mod' || facets.type === 'modpack')) {
        return { hits: [], total_hits: 0 };
    }

    if (source === 'curseforge') {
        return searchCurseForge(query, facets, limit, offset);
    }
    if (source === 'modrinth') {
        return searchModrinth(query, facets, limit, offset);
    }

    // Parallel search both
    const [modrinthRes, cfRes] = await Promise.allSettled([
        searchModrinth(query, facets, Math.ceil(limit / 2), offset),
        searchCurseForge(query, facets, Math.ceil(limit / 2), offset),
    ]);

    const modrinthHits = modrinthRes.status === 'fulfilled' ? modrinthRes.value.hits : [];
    const cfHits = cfRes.status === 'fulfilled' ? cfRes.value.hits : [];
    const modrinthTotal = modrinthRes.status === 'fulfilled' ? modrinthRes.value.total_hits : 0;
    const cfTotal = cfRes.status === 'fulfilled' ? cfRes.value.total_hits : 0;

    // Tag Modrinth hits
    modrinthHits.forEach(h => { h._source = 'modrinth'; });

    // Interleave results
    const combined = [];
    const maxLen = Math.max(modrinthHits.length, cfHits.length);
    for (let i = 0; i < maxLen; i++) {
        if (i < modrinthHits.length) combined.push(modrinthHits[i]);
        if (i < cfHits.length) combined.push(cfHits[i]);
    }

    return {
        hits: combined.slice(0, limit),
        total_hits: modrinthTotal + cfTotal,
    };
}

// ===== MOJANG =====
export async function fetchMojangVersions() {
    try {
        const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        if (!res.ok) throw new Error('Netzwerkfehler beim Laden der Versionen');
        const data = await res.json();
        return data.versions;
    } catch (e) {
        console.error(e);
        return [];
    }
}

// ===== MODRINTH =====
export async function searchModrinth(query, facets, limit = 20, offset = 0) {
    try {
        const facetArray = [];
        if (facets.type) facetArray.push([`project_type:${facets.type}`]);
        if (facets.loader) facetArray.push([`categories:${facets.loader}`]);
        if (facets.version) facetArray.push([`versions:${facets.version}`]);
        if (facets.category) facetArray.push([`categories:${facets.category}`]);

        const url = new URL(`${MODRINTH_API}/search`);
        url.searchParams.append('query', query);
        url.searchParams.append('limit', limit);
        url.searchParams.append('offset', offset);
        if (facetArray.length > 0) {
            url.searchParams.append('facets', JSON.stringify(facetArray));
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error('Fehler bei der Modrinth-Suche');
        return await res.json();
    } catch (e) {
        console.error(e);
        throw e;
    }
}

export async function getModVersion(slug, loader, mcVersion) {
    try {
        // Handle CurseForge slugs
        if (typeof slug === 'string' && slug.startsWith('cf:')) {
            const cfId = parseInt(slug.replace('cf:', ''));
            return getCurseForgeModVersion(cfId, loader, mcVersion);
        }

        const url = new URL(`${MODRINTH_API}/project/${slug}/version`);
        if (loader) url.searchParams.append('loaders', JSON.stringify([loader]));
        if (mcVersion) url.searchParams.append('game_versions', JSON.stringify([mcVersion]));

        const res = await fetch(url);
        if (!res.ok) throw new Error('Fehler beim Abrufen der Mod-Version');
        const versions = await res.json();
        
        if (versions.length === 0) {
            throw new Error(`Keine kompatible Version für ${loader} ${mcVersion} gefunden.`);
        }
        
        const version = versions[0];
        const primaryFile = version.files.find(f => f.primary) || version.files[0];
        
        return {
            url: primaryFile.url,
            filename: primaryFile.filename,
            dependencies: version.dependencies || []
        };
    } catch (e) {
        console.error(e);
        throw e;
    }
}

export async function resolveAllDependencies(modVersionData, loader, mcVersion) {
    const toDownload = [{ url: modVersionData.url, filename: modVersionData.filename }];
    const resolvedIds = new Set();
    
    async function resolve(deps) {
        for (const dep of deps) {
            if (dep.dependency_type !== 'required') continue;
            
            try {
                let vInfo;

                // CurseForge dependency
                if (dep._cfId) {
                    if (resolvedIds.has(`cf:${dep._cfId}`)) continue;
                    resolvedIds.add(`cf:${dep._cfId}`);
                    vInfo = await getCurseForgeModVersion(dep._cfId, loader, mcVersion);
                }
                // Modrinth dependency
                else if (dep.version_id) {
                    if (resolvedIds.has(dep.version_id)) continue;
                    resolvedIds.add(dep.version_id);
                    
                    const res = await fetch(`${MODRINTH_API}/version/${dep.version_id}`);
                    if (!res.ok) continue;
                    const vData = await res.json();
                    vInfo = {
                        url: vData.files[0].url,
                        filename: vData.files[0].filename,
                        dependencies: vData.dependencies || []
                    };
                } else if (dep.project_id) {
                    if (resolvedIds.has(dep.project_id)) continue;
                    resolvedIds.add(dep.project_id);
                    
                    vInfo = await getModVersion(dep.project_id, loader, mcVersion);
                }
                
                if (vInfo) {
                    toDownload.push({ url: vInfo.url, filename: vInfo.filename });
                    if (vInfo.dependencies && vInfo.dependencies.length > 0) {
                        await resolve(vInfo.dependencies);
                    }
                }
            } catch (e) {
                console.warn('Dependency resolution failed for', dep, e);
            }
        }
    }
    
    await resolve(modVersionData.dependencies);
    return toDownload;
}

export async function getModDescription(slug, source = 'modrinth', cfId = null) {
    try {
        if (source === 'curseforge' && cfId) {
            const res = await fetch(`${CF_API}/mods/${cfId}/description`, {
                headers: { 'x-api-key': CF_API_KEY, 'Accept': 'application/json' }
            });
            if (!res.ok) return 'Keine Beschreibung verfügbar.';
            const data = await res.json();
            return data.data || 'Keine Beschreibung verfügbar.';
        } else {
            const res = await fetch(`${MODRINTH_API}/project/${slug}`);
            if (!res.ok) return 'Keine Beschreibung verfügbar.';
            const data = await res.json();
            return data.body || data.description || 'Keine Beschreibung verfügbar.';
        }
    } catch (e) {
        return 'Fehler beim Laden der Beschreibung.';
    }
}
