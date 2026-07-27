export function showToast(title, message, type = 'info', id = null) {
    const container = document.getElementById('toast-container');
    
    // If id is provided, check if it exists to update progress
    let toast = id ? document.getElementById(`toast-${id}`) : null;
    
    if (!toast) {
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
            removeToast(toast);
        });
        
        container.appendChild(toast);
        
        // Auto dismiss non-progress toasts
        if (type !== 'progress') {
            setTimeout(() => removeToast(toast), 5000);
        }
    } else {
        // Update existing toast
        toast.querySelector('.toast-title').textContent = title;
        toast.querySelector('.toast-msg').textContent = message;
        toast.className = `toast ${type}`; // Update type (e.g. progress -> success)
        
        if (type !== 'progress') {
            const bar = toast.querySelector('.toast-progress-bg');
            if (bar) bar.style.display = 'none';
            setTimeout(() => removeToast(toast), 5000);
        }
    }
    
    return toast;
}

export function updateToastProgress(id, progressPercent) {
    const toast = document.getElementById(`toast-${id}`);
    if (toast) {
        const bar = toast.querySelector('.toast-progress-bar');
        if (bar) bar.style.width = `${progressPercent}%`;
    }
}

function removeToast(toast) {
    toast.style.animation = 'slideOutRight 0.3s forwards';
    setTimeout(() => {
        if (toast.parentElement) toast.parentElement.removeChild(toast);
    }, 300);
}
