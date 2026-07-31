export function showToast(title, message, type = 'info', id = null) {
    const container = document.getElementById('toast-container');
    if (!container) return null;

    let toast = id ? document.getElementById(`toast-${id}`) : null;

    if (!toast) {
        // Prevent toast stacking: synchronously remove oldest toasts if container has 3 or more
        while (container.children.length >= 3) {
            removeToast(container.firstElementChild, true, true);
        }

        toast = document.createElement('div');
        toast.className = `toast ${type}`;
        if (id) toast.id = `toast-${id}`;

        toast.innerHTML = `
            <svg class="toast-close" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <div class="toast-title">${title}</div>
            <div class="toast-msg">${message}</div>
            ${type === 'progress' ? `
            <div class="toast-progress-bg">
                <div class="toast-progress-bar"></div>
            </div>` : ''}
        `;

        toast.querySelector('.toast-close').addEventListener('click', () => {
            removeToast(toast, false, true);
        });

        container.appendChild(toast);

        // Auto dismiss non-progress toasts quickly, and safety-dismiss progress toasts after 10s
        if (type !== 'progress') {
            setTimeout(() => removeToast(toast, false, true), type === 'success' ? 2500 : 4000);
        } else {
            setTimeout(() => removeToast(toast, false, true), 10000);
        }
    } else {
        if (toast.dataset.removing === 'true') return toast;
        // Update existing toast
        const titleEl = toast.querySelector('.toast-title');
        const msgEl = toast.querySelector('.toast-msg');
        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;
        toast.className = `toast ${type}`;

        if (type !== 'progress') {
            const bar = toast.querySelector('.toast-progress-bg');
            if (bar) bar.style.display = 'none';
            toast.dataset.completed = 'true';
            setTimeout(() => removeToast(toast, false, true), 2500);
        }
    }

    return toast;
}

export function updateToastProgress(id, progressPercent) {
    const toast = document.getElementById(`toast-${id}`);
    if (toast && toast.dataset.removing !== 'true') {
        const bar = toast.querySelector('.toast-progress-bar');
        if (bar) bar.style.width = `${progressPercent}%`;
    }
}

export function removeToast(toast, immediate = false, force = false) {
    if (!toast) return;
    if (immediate) {
        if (toast.parentElement) toast.parentElement.removeChild(toast);
        return;
    }
    if (toast.dataset.removing === 'true' && !force) return;
    toast.dataset.removing = 'true';
    toast.style.animation = 'slideOutRight 0.3s forwards';
    setTimeout(() => {
        if (toast && toast.parentElement) toast.parentElement.removeChild(toast);
    }, 300);
}
