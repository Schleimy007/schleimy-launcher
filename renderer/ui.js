export function initUI() {
    // Tabs
    const navItems = document.querySelectorAll('.nav-item');
    const tabs = document.querySelectorAll('.tab-container');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(n => n.classList.remove('active'));
            tabs.forEach(t => t.classList.remove('active'));
            
            item.classList.add('active');
            const target = item.getAttribute('data-tab');
            document.getElementById(`tab-${target}`).classList.add('active');
        });
    });

    // Modals
    const createModal = document.getElementById('modal-create');
    document.getElementById('btn-new-instance').addEventListener('click', () => {
        createModal.classList.add('active');
    });
    document.getElementById('btn-create-cancel').addEventListener('click', () => {
        createModal.classList.remove('active');
    });

    const instModal = document.getElementById('modal-instance');
    document.getElementById('btn-inst-close').addEventListener('click', () => {
        instModal.classList.remove('active');
    });

    const modDetailModal = document.getElementById('modal-mod-detail');
    document.getElementById('btn-mod-detail-close').addEventListener('click', () => {
        modDetailModal.classList.remove('active');
    });

    // Close modals on overlay click
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            e.target.classList.remove('active');
        }
    });
}

export function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
}

export function openInstanceModal(name) {
    document.getElementById('inst-detail-name').textContent = name;
    document.getElementById('modal-instance').classList.add('active');
}

export function renderSkeletonGrid(containerId, count = 12) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        container.innerHTML += `
            <div class="card" style="animation-delay: ${i * 20}ms">
                <div class="mod-card-header">
                    <div class="skeleton skeleton-icon"></div>
                    <div style="flex:1;">
                        <div class="skeleton skeleton-text"></div>
                        <div class="skeleton skeleton-text short"></div>
                    </div>
                </div>
                <div class="skeleton skeleton-text"></div>
                <div class="skeleton skeleton-text short" style="margin-bottom:16px;"></div>
                <div class="skeleton skeleton-text" style="height:32px;"></div>
            </div>
        `;
    }
}
