document.addEventListener('DOMContentLoaded', async () => {
    const playBtn = document.getElementById('playBtn');
    const msLoginBtn = document.getElementById('msLoginBtn');
    const statusText = document.getElementById('statusText');
    const profileSelect = document.getElementById('profileSelect');
    const profileList = document.getElementById('profileList');
    const newProfileVersionSelect = document.getElementById('newProfileVersion');
    
    let currentAuth = null;
    let profilesData = {}; 

    // --- 1. AUTO-LOGIN PRÜFEN ---
    const savedSession = localStorage.getItem('schleimy_session');
    if (savedSession) {
        currentAuth = JSON.parse(savedSession);
        document.getElementById('playerNameDisplay').innerText = currentAuth.name;
        document.getElementById('playerName').innerText = currentAuth.name;
        document.getElementById('loginStatus').innerText = "Automatisch eingeloggt!";
        msLoginBtn.innerText = "Account wechseln";
        playBtn.disabled = false;
    }

    // --- 2. TABS WECHSELN ---
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.style.display = 'none');
            btn.classList.add('active');
            document.getElementById(btn.dataset.target).style.display = 'block';
        });
    });

    // --- 3. ALLE MOJANG VERSIONEN LADEN (OHNE FILTER) ---
    async function loadAllMinecraftVersions() {
        try {
            const response = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
            const data = await response.json();
            
            newProfileVersionSelect.innerHTML = ''; 

            data.versions.forEach(version => {
                const opt = document.createElement('option');
                opt.value = version.id;
                
                let typeLabel = version.type === 'release' ? '🟢 Release' : 
                                version.type === 'snapshot' ? '🟠 Snapshot' : 
                                version.type === 'old_beta' ? '🟡 Beta' : '🟣 Alpha';

                opt.innerText = `${version.id} (${typeLabel})`; 
                newProfileVersionSelect.appendChild(opt);
            });
        } catch (error) {
            newProfileVersionSelect.innerHTML = '<option value="1.20.4">1.20.4 (Offline Fallback)</option>';
        }
    }

    // --- 4. PROFILE LADEN & ERSTELLEN ---
    async function loadProfiles() {
        if (!window.electronAPI) return;
        
        const savedProfiles = JSON.parse(localStorage.getItem('schleimy_profiles')) || {};
        profilesData = savedProfiles;

        profileSelect.innerHTML = '<option value="">Profil wählen...</option>';
        profileList.innerHTML = '';

        Object.keys(profilesData).forEach(pName => {
            const data = profilesData[pName];
            
            const opt = document.createElement('option');
            opt.value = pName; 
            opt.innerText = `${pName} (${data.loader} - ${data.version})`;
            profileSelect.appendChild(opt);

            let color = data.loader === 'fabric' ? '#ebd2a9' : data.loader === 'forge' ? '#dfa86a' : '#10b981';
            
            const card = document.createElement('div');
            card.className = 'mod-card';
            card.style.borderTop = `3px solid ${color}`;
            card.innerHTML = `
                <h3>📦 ${pName}</h3>
                <p style="margin-bottom: 5px;"><strong>Loader:</strong> <span style="color:${color}; text-transform:capitalize;">${data.loader}</span></p>
                <p><strong>Version:</strong> ${data.version}</p>
            `;
            profileList.appendChild(card);
        });
    }

    document.getElementById('createProfileBtn').addEventListener('click', async () => {
        const name = document.getElementById('newProfileName').value.trim();
        const loader = document.getElementById('newProfileLoader').value;
        const version = newProfileVersionSelect.value;

        if (name && version && window.electronAPI) {
            await window.electronAPI.createProfile(name);
            
            const savedProfiles = JSON.parse(localStorage.getItem('schleimy_profiles')) || {};
            savedProfiles[name] = { loader: loader, version: version };
            localStorage.setItem('schleimy_profiles', JSON.stringify(savedProfiles));

            document.getElementById('newProfileName').value = '';
            statusText.innerText = `Profil ${name} erfolgreich erstellt!`;
            loadProfiles();
        } else {
            alert("Bitte gib einen Namen ein und wähle eine Version aus!");
        }
    });

    await loadProfiles(); 
    loadAllMinecraftVersions();

    // --- 5. MICROSOFT LOGIN ---
    msLoginBtn.addEventListener('click', async () => {
        msLoginBtn.disabled = true;
        document.getElementById('loginStatus').innerText = "Warte auf Login...";
        if (window.electronAPI) {
            const result = await window.electronAPI.loginMicrosoft();
            if (result.success) {
                currentAuth = result.token;
                localStorage.setItem('schleimy_session', JSON.stringify(currentAuth));
                document.getElementById('playerNameDisplay').innerText = currentAuth.name;
                document.getElementById('playerName').innerText = currentAuth.name;
                document.getElementById('loginStatus').innerText = "Erfolgreich eingeloggt!";
                msLoginBtn.innerText = "Account wechseln";
                msLoginBtn.disabled = false;
                playBtn.disabled = false;
            } else {
                document.getElementById('loginStatus').innerText = "Login fehlgeschlagen!";
                msLoginBtn.disabled = false;
            }
        }
    });

    // --- 6. MODRINTH API & SUCHE ---
    document.getElementById('searchBtn').addEventListener('click', async () => {
        const query = document.getElementById('searchInput').value;
        const modGrid = document.getElementById('modGrid');
        if (!query.trim()) return;
        
        modGrid.innerHTML = "<p>Suche auf Modrinth...</p>";
        try {
            const response = await fetch(`https://api.modrinth.com/v2/search?query=${query}&limit=12`);
            const data = await response.json();
            modGrid.innerHTML = "";
            
            data.hits.forEach(mod => {
                const card = document.createElement('div');
                card.className = 'mod-card';
                card.innerHTML = `
                    <h3>${mod.title}</h3>
                    <p style="font-size:0.85rem; color:var(--text-muted);">${mod.description.substring(0, 60)}...</p>
                    <button class="action-btn" style="width:100%; margin-top:10px;" id="dl-${mod.slug}">In Profil installieren</button>
                `;
                modGrid.appendChild(card);
                document.getElementById(`dl-${mod.slug}`).addEventListener('click', () => downloadMod(mod.slug));
            });
        } catch (error) {
            modGrid.innerHTML = "<p>Fehler beim API-Abruf.</p>";
        }
    });

    async function downloadMod(slug) {
        const selectedProfile = profileSelect.value;
        if (!selectedProfile) return alert("Bitte wähle unten in der Leiste zuerst ein Profil aus!");

        statusText.innerText = `Hole Download-Link für ${slug}...`;
        try {
            const res = await fetch(`https://api.modrinth.com/v2/project/${slug}/version`);
            const versions = await res.json();
            const latestFile = versions[0].files[0]; 
            
            window.electronAPI.downloadMod({
                downloadUrl: latestFile.url,
                profileName: selectedProfile,
                fileName: latestFile.filename
            });
        } catch (err) {
            statusText.innerText = `Fehler: ${err.message}`;
        }
    }

    // --- 7. SPIEL STARTEN ---
    playBtn.addEventListener('click', () => {
        const selectedProfile = profileSelect.value;
        if (!currentAuth) return alert("Bitte erst einloggen!");
        if (!selectedProfile) return alert("Bitte wähle ein Profil aus!");

        const profileInfo = profilesData[selectedProfile];

        playBtn.innerText = "STARTET...";
        playBtn.disabled = true;
        playBtn.classList.add('loading');

        window.electronAPI.startGame({ 
            version: profileInfo.version, 
            auth: currentAuth,
            profileName: selectedProfile,
            loader: profileInfo.loader 
        });
    });

    if (window.electronAPI) {
        window.electronAPI.onStatusUpdate((status) => {
            statusText.innerText = status;
            if(status.includes('🚀 Spiel gestartet!') || status.includes('Fehler') || status.includes('beendet')) {
                playBtn.innerText = "SPIELEN";
                playBtn.disabled = false;
                playBtn.classList.remove('loading');
            }
        });
    }
});